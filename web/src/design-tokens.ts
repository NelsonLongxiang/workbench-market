/** 由 scripts/gen-design-tokens.mjs 从 DESIGN.md v1.0.0 生成，勿手改；改 token 请改 DESIGN.md 后重新生成。 */
export const DESIGN_TOKENS = {
  "version": "1.0.0",
  "colors": {
    "primary": "#1E3A5F",
    "on-primary": "#FFFFFF",
    "primary-subtle": "#EEF2F7",
    "text": "#0F172A",
    "text-secondary": "#5A6577",
    "text-disabled": "#94A3B8",
    "page": "#F6F7F9",
    "surface": "#FFFFFF",
    "border": "#E2E8F0",
    "border-strong": "#CBD5E1",
    "success": "#047857",
    "success-text": "#047857",
    "success-bg": "#ECFDF5",
    "warning": "#F59E0B",
    "warning-text": "#B45309",
    "warning-bg": "#FFFBEB",
    "danger": "#DC2626",
    "danger-text": "#B91C1C",
    "danger-bg": "#FEF2F2",
    "nav-bg": "#0F172A",
    "nav-text": "#CBD5E1",
    "nav-text-active": "#FFFFFF",
    "nav-item-active-bg": "#1E3A5F",
    "info": "#1E3A5F",
    "info-bg": "#EEF2F7"
  },
  "typography": {
    "family-sans": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
    "family-mono": "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
    "caption": {
      "fontSize": "12px",
      "lineHeight": "20px",
      "fontWeight": 400
    },
    "body": {
      "fontSize": "14px",
      "lineHeight": "22px",
      "fontWeight": 400
    },
    "body-strong": {
      "fontSize": "14px",
      "lineHeight": "22px",
      "fontWeight": 600
    },
    "subtitle": {
      "fontSize": "16px",
      "lineHeight": "24px",
      "fontWeight": 600
    },
    "title": {
      "fontSize": "20px",
      "lineHeight": "28px",
      "fontWeight": 600
    },
    "display": {
      "fontSize": "24px",
      "lineHeight": "32px",
      "fontWeight": 600
    },
    "stat-label": {
      "fontSize": "12px",
      "lineHeight": "20px",
      "fontWeight": 600,
      "letterSpacing": "0.05em",
      "textTransform": "uppercase"
    }
  },
  "spacing": {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "6": "24px",
    "8": "32px",
    "12": "48px"
  },
  "rounded": {
    "sm": "4px",
    "md": "6px",
    "lg": "8px",
    "full": "9999px"
  },
  "elevation": {
    "0": "none",
    "1": "0 1px 2px rgba(15, 23, 42, 0.05)",
    "2": "0 4px 12px rgba(15, 23, 42, 0.10)",
    "3": "0 12px 32px rgba(15, 23, 42, 0.16)"
  },
  "motion": {
    "fast": "120ms",
    "base": "200ms",
    "easing": "ease"
  }
} as const;
