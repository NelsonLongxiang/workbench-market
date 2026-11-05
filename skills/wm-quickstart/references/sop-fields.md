# SOP 步骤字段：校验属性与文件清单

SOP 步骤正文（`sop.yaml` 各步的 `body`）里，带 `data-field="<字段名>"` 的 `input`、`textarea`、`select` 会被执行页收集和保存，按步骤存成 `{ <步骤>: { <字段>: 值 } }`。字段上写的校验属性有两处生效：执行页边填边提示，完成时服务端再按同一套规则核一遍。没写这些属性的 SOP 不受影响。

## 通用属性

| 属性 | 作用 |
|---|---|
| `data-label` | 字段的显示名，用于报错文字和读屏名称 |
| `required` | 必填 |
| `pattern` | 整体匹配的正则。`textarea` 也支持，按 `u` 标志编译 |
| `minlength` / `maxlength` | 长度 |
| `type="url\|number\|date\|month\|email"`、`min` / `max` | 类型校验，仅 `input` |
| `data-error` | 格式不符时显示的提示（必填的提示不用它） |
| `data-required-if="<字段>=<值1>\|<值2>"` | 条件必填。字段写成 `<步骤>.<字段>` 可以跨步；条件成立才必填，不成立时只核格式 |

## 文件清单字段

在 `textarea` 上加 `data-type="file-list"`，执行页会把它换成一个表格编辑器。每行从本记录已有的文件里选（自己上传的，或引用同一 SOP 其他记录的），并自动带出文件名、sha256、大小和类型。

```html
<textarea data-field="delivery_files" data-label="交付文件清单" data-type="file-list"
  data-roles="交付件|验证报告|归档" data-statuses="有效|作废" data-void-statuses="作废" data-min-items="1" data-max-items="50"></textarea>
```

- 值是行对象数组：`[{ file_id, name, role, source, period, status, sha256, size, mime }]`。
- `data-roles` / `data-statuses` 给出可选值；不写时就是自由文本。`data-min-items` / `data-max-items` 限制行数；`required` 表示至少要有一行。
- `data-void-statuses` 标出不算数的状态（如 `作废`）：这些行照样核结构，但不计入 `required` 和 `data-min-items`。全部行都标作废，等于没填。
- 完成时服务端逐行对照文件面核对：`file_id` 必须是本记录的文件；登记的 `sha256` 必须等于文件的实际内容；文件名必须一致。同名但内容不同的文件，或者换了文件却沿用旧登记，都会被拦下。
- agent 直接写数据时，也按这个结构写。`sha256` 取上传回执里的值，或 `GET /api/sop/runs/<id>/files` 里的值，不要自己编。

## 相关接口

- 引用已有文件，不用重传：`POST /api/sop/runs/<id>/files/refs`（见市场 README）。
- SOP 改了字段规则后，进行中的记录可以先预检，再由管理员升级到当前版本：`GET …/upgrade-preflight`，然后 `POST …/upgrade`。
