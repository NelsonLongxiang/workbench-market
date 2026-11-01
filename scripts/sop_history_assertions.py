"""Shared #309 history assertions used by full E2E group 18 and focused Chromium checks."""
import json,re
from playwright.sync_api import expect

def assert_metadata_history(drawer,actor,expected_steps,requests,history_rows,forbidden_values=()):
    row=drawer.locator('.ant-table-row').filter(has_text=actor).first
    expect(row).to_be_visible()
    headers=drawer.locator('thead th').all_text_contents()
    step_index=next(i for i,name in enumerate(headers) if '步骤数' in name)
    expect(row.locator('td').nth(step_index)).to_have_text(str(expected_steps))
    assert drawer.locator('.ant-table-row-expand-icon').count()==0,'history must not expand private step values'
    assert history_rows,'history response was not observed'
    allowed={'id','sop_slug','sop_version','status','started_by','started_at','updated_at','finished_at','steps'}
    for item in history_rows:
        assert set(item)<=allowed,'history contains non-metadata columns'
        assert 'data' not in item and 'upload_token' not in item,'history exposes private fields or write token'
    text=drawer.inner_text();serialized=json.dumps(history_rows,ensure_ascii=False)
    for value in forbidden_values:
        assert value not in text and value not in serialized,'private synthetic step value visible in history'
    assert not any(re.search(r'/api/sop/runs/[0-9]+(?:[/?]|$)',url,re.I) for url in requests),'history must not recover private values through single-run fetch'
    assert '此列表仅展示执行元数据与步骤数量' in text,'metadata-only history scope notice missing'
