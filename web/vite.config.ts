import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep the dependency graph in one cacheable chunk: hand-picked package buckets
        // produced cross-vendor cycles and TDZ failures in an actual Windows build.
        manualChunks(id) {
          return id.includes('node_modules') ? 'vendor' : undefined;
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
