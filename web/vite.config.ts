import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 供应商拆包：单 2.35MB 大包 → 按依赖域分组，长缓存友好（业务改动不再整包失效）。
        // 函数式归桶（对象式只列直接依赖，rc-*/scheduler 等传递依赖会被 Rollup 自动归组导致 chunk 循环）
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('react-grid-layout') || id.includes('react-resizable')) return 'grid-vendor';
          if (id.includes('react-markdown') || id.includes('micromark') || id.includes('mdast') || id.includes('hast') || id.includes('unist') || id.includes('vfile'))
            return 'markdown-vendor';
          if (id.includes('react-router') || id.includes('@remix-run') || id.includes('/react/') || id.includes('/react-dom/') || id.includes('scheduler'))
            return 'react-vendor';
          if (id.includes('@ant-design/pro-')) return 'pro-vendor';
          // antd 生态（antd/icons/ahooks/dayjs/rc-*）统一桶：依赖方向单向 → react-vendor，无环
          return 'antd-vendor';
        },
      },
    },
    // 内网单机工具：antd 生态整桶 >500KB 是有意取舍（LAN 带宽 + 长缓存收益优先），抬高告警线
    chunkSizeWarningLimit: 1700,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9800', changeOrigin: true },
    },
  },
});
