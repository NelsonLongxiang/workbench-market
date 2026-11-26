/** #1099 块锚点、本页目录、复制本块链接、回到顶部（数据视图页和报告页共用）。滚动的是页面里的 .wm-bp-body，不是整个窗口。 */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { App, Button, Tooltip } from 'antd';
import { LinkOutlined, VerticalAlignTopOutlined } from '@ant-design/icons';
import { activeTocKey, anchorFromHash, anchorUrl, showBackToTop, type TocEntry } from '../page-toc-view';

/** 块的外框从这里拿自己的锚点（数据视图里由 jr/registry.tsx 按块给；驾驶舱面板不给） */
export const BlockAnchorContext = createContext<string | null>(null);
export const useBlockAnchor = () => useContext(BlockAnchorContext);

const scrollerOf = (el: Element | null): HTMLElement | null => (el?.closest('.wm-bp-body') as HTMLElement | null) ?? null;
const FLASH_MS = 1800;
function flash(el: HTMLElement) {
  el.classList.remove('wm-anchor-flash'); void el.offsetWidth; el.classList.add('wm-anchor-flash');
  window.setTimeout(() => el.classList.remove('wm-anchor-flash'), FLASH_MS);
}

/** 打开带 #<块键> 的地址：内容画好以后定位到那一块并短暂高亮。同一个地址只跳一次（后台刷新不再拉回去） */
export function useAnchorJump(ready: boolean, scope: string) {
  const { hash } = useLocation();
  const done = useRef('');
  useEffect(() => {
    const key = anchorFromHash(hash);
    if (!ready || !key || done.current === `${scope}#${key}`) return;
    const r = requestAnimationFrame(() => {
      const el = document.getElementById(key);
      if (!el) return;
      done.current = `${scope}#${key}`;
      el.scrollIntoView({ block: 'start' });
      flash(el);
    });
    return () => cancelAnimationFrame(r);
  }, [ready, hash, scope]);
}

/** 块标题旁的「复制本块链接」 */
export function CopyAnchorButton({ anchor }: { anchor: string }) {
  const { message } = App.useApp();
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = anchorUrl(window.location.origin, window.location.pathname, window.location.search, anchor);
    try { await navigator.clipboard.writeText(url); void message.success('已复制这一块的链接'); }
    catch { void message.warning(`没能写进剪贴板，请手动复制：${url}`); }
  };
  return (
    <Tooltip title="复制本块链接">
      <Button type="text" size="small" className="wm-anchor-copy" icon={<LinkOutlined />} aria-label="复制本块链接" onClick={(e) => void copy(e)} data-testid="copy-anchor" data-anchor={anchor} />
    </Tooltip>
  );
}

/** 本页目录：右侧一列，随滚动区固定；点了平滑跳过去并改地址里的 #，滚动时高亮当前所在的块 */
export function PageToc({ entries }: { entries: TocEntry[] }) {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | null>(entries[0]?.key ?? null);
  const keys = entries.map((e) => e.key).join('|');
  useEffect(() => {
    const sc = scrollerOf(ref.current);
    if (!sc) return;
    const spy = () => {
      const base = sc.getBoundingClientRect().top;
      const tops = entries.flatMap((e) => { const el = document.getElementById(e.key); return el ? [{ key: e.key, top: el.getBoundingClientRect().top - base }] : []; });
      setActive(activeTocKey(tops, 80, sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 && sc.scrollTop > 0));
    };
    spy();
    sc.addEventListener('scroll', spy, { passive: true });
    return () => sc.removeEventListener('scroll', spy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  const go = (key: string) => {
    const el = document.getElementById(key);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${encodeURIComponent(key)}`);
    setActive(key); flash(el);
  };
  return (
    <nav ref={ref} className="wm-toc" aria-label="本页目录" data-testid="page-toc">
      <div className="wm-toc-title">本页目录</div>
      <ul>
        {entries.map((e) => (
          <li key={e.key} className={`wm-toc-l${Math.min(e.level, 3)}`}>
            <a href={`#${encodeURIComponent(e.key)}`} aria-current={active === e.key ? 'true' : undefined} className={active === e.key ? 'on' : undefined}
              onClick={(ev) => { ev.preventDefault(); go(e.key); }} data-key={e.key}>{e.title}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** 回到顶部：滚过一屏出现。挂在滚动区里的任一处 */
export function BackToTop() {
  const ref = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const sc = scrollerOf(ref.current);
    if (!sc) return;
    const on = () => setShow(showBackToTop(sc.scrollTop, sc.clientHeight));
    on(); sc.addEventListener('scroll', on, { passive: true });
    return () => sc.removeEventListener('scroll', on);
  }, []);
  return (
    <span ref={ref}>
      {show ? <Button className="wm-back-top" shape="circle" icon={<VerticalAlignTopOutlined />} aria-label="回到顶部" title="回到顶部"
        onClick={() => scrollerOf(ref.current)?.scrollTo({ top: 0, behavior: 'smooth' })} data-testid="back-to-top" /> : null}
    </span>
  );
}

/** 正文加右侧目录的两栏；没有目录条目时原样只放正文 */
export function TocLayout({ entries, children }: { entries: TocEntry[]; children: React.ReactNode }) {
  if (!entries.length) return <>{children}</>;
  return <div className="wm-toc-layout"><div className="wm-toc-main">{children}</div><PageToc entries={entries} /></div>;
}
