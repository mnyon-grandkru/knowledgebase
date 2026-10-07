"""Headless browser smoke test for the admin panel.

Serves admin/ locally, stubs the CDN libs from node_modules and the GitHub API,
then exercises read and write flows. Run: python3 test/smoke_test.py
"""
import functools, http.server, json, pathlib, socketserver, sys, threading

from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
ADMIN = ROOT / "admin"
DATA = json.loads((ADMIN / "data" / "issues.json").read_text())
CDN = {
    "marked.min.js": ROOT / "node_modules/marked/marked.min.js",
    "purify.min.js": ROOT / "node_modules/dompurify/dist/purify.min.js",
}
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        failures.append(name)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(ADMIN))
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def route_cdn(route):
    name = route.request.url.rsplit("/", 1)[-1]
    route.fulfill(path=str(CDN[name]), content_type="application/javascript")


def main():
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    issues = DATA["issues"]
    target = next((i for i in issues if i["comments"]), issues[0])
    api_calls = []

    def route_api(route):
        req = route.request
        api_calls.append((req.method, req.url, req.headers.get("authorization"), req.post_data))
        if req.method == "PUT" and req.url.endswith("/labels"):
            body = json.loads(req.post_data)
            route.fulfill(json=[{"name": n, "color": "0969da"} for n in body["labels"]])
        elif req.method == "POST" and req.url.endswith("/comments"):
            body = json.loads(req.post_data)
            route.fulfill(json={"user": {"login": "tester"}, "created_at": "2026-10-07T00:00:00Z",
                                "body": body["body"], "html_url": "https://github.com/x#c"})
        else:
            route.fulfill(status=500, json={"message": "unexpected"})

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---------- Desktop, read-only ----------
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        ctx.route("https://cdnjs.cloudflare.com/**", route_cdn)
        ctx.route("https://api.github.com/**", route_api)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base)
        page.wait_for_selector("body[data-ready=true]", timeout=10000)

        page.click('[data-view="all"]')
        rows = page.locator(".issue-row[data-number]")
        check("all view lists every snapshot issue", rows.count() == len(issues), f"{rows.count()} vs {len(issues)}")

        review_count = int(page.locator('[data-view="review"] .count').inner_text())
        page.click('[data-view="review"]')
        check("review view count matches badge", rows.count() == review_count, f"{rows.count()} vs {review_count}")

        page.click('[data-view="all"]')
        page.fill("#search", "KeePassXC")
        page.wait_for_timeout(300)
        titles = rows.all_inner_texts()
        check("search filters to KeePassXC issue", 0 < len(titles) < len(issues) and any("KeePassXC" in t for t in titles), str(len(titles)))
        page.fill("#search", "")
        page.wait_for_timeout(300)

        page.click('.chip[data-label="windows"]')
        n_windows = sum(1 for i in issues if any(l["name"] == "windows" for l in i["labels"]))
        check("label chip filters", rows.count() == n_windows, f"{rows.count()} vs {n_windows}")
        page.click("#clear-labels")

        page.click(f'.issue-row[data-number="{target["number"]}"]')
        expect(page.locator(".detail-head h2")).to_have_text(target["title"])
        check("detail shows title", True)
        posts = page.locator(".post").count()
        check("detail renders body + comments", posts == 1 + len(target["comments"]), f"{posts}")
        check("markdown rendered (no raw <pre> fallback)", page.locator(".md").first.evaluate("e => !e.querySelector(':scope > pre') || e.innerHTML.includes('<code')"))
        check("write actions disabled without token", page.locator('[data-action="close"], [data-action="reopen"]').first.is_disabled())
        check("open-on-GitHub always enabled", page.locator('[data-action="open"]').is_enabled())
        check("hash deep link updated", page.evaluate("location.hash") == f"#{target['number']}")

        page.keyboard.press("j")
        sel = page.locator('.issue-row[aria-selected="true"]').get_attribute("data-number")
        check("j moves selection", sel is not None and int(sel) != target["number"], str(sel))
        check("no page errors (read-only)", not errors, "; ".join(errors))
        ctx.close()

        # ---------- Desktop, with token: write flows ----------
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        ctx.route("https://cdnjs.cloudflare.com/**", route_cdn)
        ctx.route("https://api.github.com/**", route_api)
        ctx.add_init_script("localStorage.setItem('kb_admin_token','test-token')")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        untriaged = next(i for i in issues if not any(l["name"].startswith("kb:") for l in i["labels"]))
        page.goto(base + f"#{untriaged['number']}")
        page.wait_for_selector("body[data-ready=true]", timeout=10000)
        check("deep link opens issue", page.locator(".detail-head h2").inner_text() == untriaged["title"])
        check("meta shows write enabled", "write enabled" in page.locator("#snapshot-meta").inner_text())

        page.click('[data-action="candidate"]')
        expect(page.locator(".detail-meta .pill.candidate")).to_be_visible()
        put = [c for c in api_calls if c[0] == "PUT"]
        check("KB candidate -> PUT labels with token",
              bool(put) and put[-1][2] == "Bearer test-token" and "kb:candidate" in json.loads(put[-1][3])["labels"])

        page.click('[data-action="publish"]')
        expect(page.locator(".detail-meta .pill.published")).to_be_visible()
        labels = json.loads([c for c in api_calls if c[0] == "PUT"][-1][3])["labels"]
        check("publish swaps candidate for published", "kb:published" in labels and "kb:candidate" not in labels, str(labels))

        before = page.locator(".post").count()
        page.fill("#comment-body", "Fix recorded by smoke test")
        page.click(".comment-form button[type=submit]")
        expect(page.locator(".post")).to_have_count(before + 1)
        check("comment POST appends post", True)
        check("no page errors (write)", not errors, "; ".join(errors))
        ctx.close()

        # ---------- Phone ----------
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        ctx.route("https://cdnjs.cloudflare.com/**", route_cdn)
        page = ctx.new_page()
        page.goto(base)
        page.wait_for_selector("body[data-ready=true]", timeout=10000)
        check("phone: detail hidden initially", not page.locator("#detail").is_visible())
        page.locator(".issue-row[data-number]").first.click()
        check("phone: tap opens detail", page.locator("#detail").is_visible() and not page.locator(".list-pane").is_visible())
        page.click(".back")
        check("phone: back returns to list", page.locator(".list-pane").is_visible())
        sw = page.evaluate("document.documentElement.scrollWidth")
        check("phone: no horizontal overflow", sw <= 390, f"scrollWidth={sw}")
        page.screenshot(path=str(ROOT / "test-results" / "phone.png"), full_page=False)
        ctx.close()

        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.route("https://cdnjs.cloudflare.com/**", route_cdn)
        page.goto(base + "#128")
        page.wait_for_selector("body[data-ready=true]", timeout=10000)
        page.wait_for_timeout(300)
        page.screenshot(path=str(ROOT / "test-results" / "desktop.png"))
        browser.close()
    srv.shutdown()

    print(f"\n{'FAILED' if failures else 'ALL PASSED'}: {len(failures)} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    (ROOT / "test-results").mkdir(exist_ok=True)
    main()
