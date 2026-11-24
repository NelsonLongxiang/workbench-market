/**
 * 图片列的缩略图（docs/image-step1.md 第五节、用例 9）：表格里 48px 见方，记录卡里 160px 高、占满宽，object-fit: cover；点开看原图。
 * 地址一律是市场的代取路由（imageSrc），浏览器不直接访问图片链接；来源视图由外面经 ImageSourceContext 给（BenchView 按这次取数的台、视图、版本、筛选值）。
 * 没有来源（比如开发演示页）、或者取不到（没权限、链接失效、不是图片、太大），显示「图片取不到」占位，不显示链接原文。样式只用 token 类名，不写内联样式。
 */
import { createContext, useContext, useState } from 'react';
import { Image } from 'antd';
import { imageSrc, type ImageSource } from './blocks-view';

export const ImageSourceContext = createContext<ImageSource | null>(null);

export function BenchImage({ value, size }: { value: unknown; size: 'cell' | 'card' }) {
  const src = imageSrc(value, useContext(ImageSourceContext));
  if (value === null || value === undefined || value === '') return <span className={size === 'cell' ? undefined : 'wm-rec-empty'}>{size === 'cell' ? '-' : '—'}</span>;
  if (!src) return <ImageMissing size={size} />;
  // 换了地址（筛选、版本变了）就重新加载：失败状态跟着地址走
  return <Thumb key={src} src={src} size={size} />;
}

function Thumb({ src, size }: { src: string; size: 'cell' | 'card' }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <ImageMissing size={size} />;
  return (
    <Image
      src={src} alt="图片" loading="lazy" className={`wm-img wm-img-${size}`} rootClassName={`wm-img-root wm-img-root-${size}`}
      onError={() => setBroken(true)} preview={{ mask: '查看原图' }} data-testid="bench-image"
    />
  );
}

function ImageMissing({ size }: { size: 'cell' | 'card' }) {
  return <span className={`wm-img-missing wm-img-missing-${size}`} role="img" aria-label="图片取不到" data-testid="bench-image-missing">图片取不到</span>;
}
