"""P0 structural Chromium + print-to-PDF checks. Only a runner-owned loopback synthetic fixture.
PDF text/geometry inspection is deliberately a separate optional local step: no new CI PDF package.
"""

import json
import os
import sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
base, out = cfg["base"], cfg["out"]
if urlparse(base).hostname != "127.0.0.1":
    raise ValueError("fixture_loopback_required")
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    try:
        for key in ("operating", "products", "next-period"):
            context = browser.new_context(viewport={"width": 1100, "height": 1000})
            page = context.new_page()
            errors = []
            requested = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("request", lambda r: requested.append(r.url))
            page.goto(base + "/" + key)
            try:
                page.wait_for_selector(".rp-document", timeout=15000)
            except Exception:
                print(
                    "FIXTURE_PAGE_DIAGNOSTIC",
                    key,
                    errors,
                    page.locator("body").inner_text()[:500],
                    flush=True,
                )
                raise
            page.evaluate("() => document.fonts.ready")
            if key != "products":
                page.wait_for_selector(
                    "[data-report-chart][data-ready=true] svg", timeout=30000
                )
            else:
                page.wait_for_function(
                    "() => Array.from(document.images).every(i=>i.complete && i.naturalWidth>0)"
                )
            page.emulate_media(media="print")
            # print styles and static charts must settle before geometry/PDF capture
            page.evaluate(
                "() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"
            )
            row_ids = page.locator("[data-report-row]").evaluate_all(
                "(els)=>els.map(e=>e.dataset.reportRow)"
            )
            text = page.locator(".rp-document").inner_text()
            chart_count = page.locator("[data-report-chart] svg").count()
            product_count = page.locator("section").count() if key == "products" else 0
            if key == "products":
                assert product_count == 50, (key, product_count)
                assert page.locator("img").count() == 50
                assert "SKU0001" in text and "SKU0050" in text and "END50" in text
            else:
                assert len(row_ids) == 308 and len(set(row_ids)) == 308, (
                    key,
                    len(row_ids),
                )
                assert row_ids == ["ROW" + str(i + 1).zfill(4) for i in range(308)]
                assert "END308" in text and chart_count == 1
                # JSX treats malicious-looking source text as text, not executable markup
                assert page.locator("script").count() == 2
                assert "NOT_EXECUTED" in text
            assert not errors, (key, errors)
            assert not any(
                urlparse(u).scheme in ("http", "https") and not u.startswith(base + "/")
                for u in requested
            ), requested
            overflow = page.locator(".rp-document").evaluate(
                "(e)=>({width:e.clientWidth,scroll:e.scrollWidth})"
            )
            assert overflow["scroll"] <= overflow["width"] + 2, (key, overflow)

            def assert_layout():
                report = page.locator(".rp-document")
                report.evaluate("e=>e.style.width='170mm'")
                report.evaluate("e=>e.style.maxWidth='170mm'")
                invalid = report.evaluate(
                    "e=>Array.from(e.querySelectorAll('[data-unsplittable],tr')).filter(x=>x.getBoundingClientRect().height>257*96/25.4).map(x=>({kind:x.tagName,height:x.getBoundingClientRect().height}))"
                )
                if invalid:
                    raise ValueError("layout_overflow " + str(invalid[:3]))

            assert_layout()
            page.evaluate(
                "() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))"
            )
            print_overflow = page.locator(".rp-document").evaluate(
                "e=>({width:e.clientWidth,scroll:e.scrollWidth})"
            )
            assert print_overflow["scroll"] <= print_overflow["width"] + 2, (
                key,
                print_overflow,
            )
            if key == "operating":
                first = page.locator("tbody tr").first
                original = first.get_attribute("style")
                first.evaluate("e=>e.style.height='1400px'")
                try:
                    assert_layout()
                    raise AssertionError("oversized row was not rejected")
                except ValueError as e:
                    assert "layout_overflow" in str(e)
                first.evaluate(
                    '(e,v)=>{if(v===null)e.removeAttribute("style");else e.setAttribute("style",v)}',
                    original,
                )
                assert_layout()
            pdf = os.path.join(out, key + ".pdf")
            page.pdf(path=pdf, prefer_css_page_size=True, print_background=True)
            with open(pdf, "rb") as f:
                assert f.read(5) == b"%PDF-"
            assert os.path.getsize(pdf) > 5000
            page.screenshot(
                path=os.path.join(out, key + "-screen.png"), full_page=False
            )
            results.append(
                {
                    "sample": key,
                    "rows": len(row_ids),
                    "products": product_count,
                    "charts": chart_count,
                    "images": page.locator("img").count(),
                    "page_errors": errors,
                    "overflow": overflow,
                    "pdf": os.path.basename(pdf),
                    "bytes": os.path.getsize(pdf),
                    "chromium": browser.version,
                }
            )
            print("PASS", key, results[-1])
            context.close()
    finally:
        browser.close()
with open(os.path.join(out, "browser-results.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print(
    "report-template-p0-browser: 3 samples passed; PDF pagination content verification still requires PDF inspection"
)
