"""Native-table real-backend browser regression, synthetic identity/data only. No business route interception."""

import csv
from urllib.parse import parse_qs, urlparse
import io
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
base, card = cfg["base"], cfg["card"]
with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(
        viewport={"width": 1440, "height": 960}, accept_downloads=True
    )
    context.add_cookies([{"name": "session_id", "value": cfg["session"], "url": base}])
    page = context.new_page()
    page.set_default_timeout(15000)
    page.goto(f"{base}/use/{card}")
    button = page.get_by_role("button", name="导出全部匹配结果")
    button.wait_for()
    table_rows = page.locator(
        "[data-bb=table] .ant-table-tbody > tr:not(.ant-table-measure-row)"
    )
    assert table_rows.count() == 50
    with page.expect_download() as event:
        button.click()
    download = event.value
    result = list(
        csv.DictReader(
            io.StringIO(Path(download.path()).read_text(encoding="utf-8-sig"))
        )
    )
    assert len(result) == 4833, len(result)
    assert result[-1]["编号"] == "4833"
    assert all(r["批次"] == "frozen" and r["来源版本"] == "v68" for r in result)
    print("PASS actual browser file download contains all4833 rows not current50")

    page.locator("[data-filter=sku] input").fill("Sample Cup")
    page.locator("[data-filter=sku] input").press("Enter")
    page.wait_for_function(
        "() => new URLSearchParams(location.search).get('p.sku') === 'Sample Cup'"
    )
    page.locator("[data-filter=warehouse] input").fill("TestWest")
    # 两个筛选都生效了才往下走：地址里两个都在，而且按两个筛选取的那一次数已经回来（等不到就超时失败）
    with page.expect_response(
        lambda r: "/render" in r.url
        and parse_qs(urlparse(r.url).query).get("p.sku") == ["Sample Cup"]
        and parse_qs(urlparse(r.url).query).get("p.warehouse") == ["TestWest"]
    ):
        page.locator("[data-filter=warehouse] input").press("Enter")
    page.wait_for_function(
        "() => { const q = new URLSearchParams(location.search); return q.get('p.sku') === 'Sample Cup' && q.get('p.warehouse') === 'TestWest'; }"
    )
    page.wait_for_function(
        "() => !Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('导出全部匹配结果'))?.disabled"
    )
    with page.expect_download() as event:
        button.click()
    result = list(
        csv.DictReader(
            io.StringIO(Path(event.value.path()).read_text(encoding="utf-8-sig"))
        )
    )
    assert len(result) == 1650, len(result)
    assert result[-1]["编号"] == "1650"
    assert all(r["商品"] == "Sample Cup" and r["仓库"] == "TestWest" for r in result)
    print("PASS filter keeps same batch/version and downloads all1650 matches")

    page.get_by_role("button", name="原行／来源详情").first.click()
    drawer = page.locator(".ant-drawer-content")
    drawer.get_by_text("同上下文原行及来源定位").wait_for()
    assert "SheetA!2" in drawer.inner_text()
    assert "=SUM(A1:A2)" in drawer.inner_text()
    detail_text = drawer.inner_text()
    print("DETAIL_CONTEXT", repr(detail_text[:1200]))
    assert "商品=Sample Cup" in detail_text and "仓库=TestWest" in detail_text, (
        detail_text[:1200]
    )
    assert drawer.locator("script").count() == 0
    print(
        "PASS business row opens real original row and source fields with same context"
    )
    page.keyboard.press("Escape")
    drawer.wait_for(state="hidden")
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("button", name="原行／来源详情").first.click()
    drawer.get_by_text("同上下文原行及来源定位").wait_for()
    assert "SheetA!2" in drawer.inner_text()
    print("PASS narrow-page row source action and details remain reachable")
    browser.close()
