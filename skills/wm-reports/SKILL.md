---
name: wm-reports
version: 0.4.0
description: 工作台市场报告编写。定义报告维度和模板、绑定台数据、生成冻结报告并回应论断。适用于编写 schema_version 2 或 3 模板、准备生成输入或查找报告入口。
---

# 编写和使用台报告

按维度、模板、台绑定、生成、回应的顺序做。维度和模板版本在市场，绑定和冻结报告在各自的台。需要授权、复核或停用重绑时，见 [wm-report-governance](../wm-report-governance/SKILL.md)。

## 1. 定义维度和模板

用有权的站内会话 POST /api/report-dimensions，填写 id、title 和适用领域的 area。维度先用 GET /api/report-dimensions/<维度> 读当前生效版和模板版本。发版用 POST /api/report-dimensions/<维度>/templates，把模板放在请求的 body 字段，另可写 note。发版追加版本。复核及激活完成后，再读 active_version 确认生效版。

以下模板有一个 orders 槽，生成方填月份、摘要和至少一条结论。槽的 key 用于论断引用数据行，列的类型要和绑定视图的查询结果一致。

```json report-template-v2
{
  "schema_version": 2,
  "title": "订单月报",
  "parameters": {
    "period": {
      "type": "month",
      "required": true
    }
  },
  "fields": {
    "summary": {
      "required": true,
      "max_length": 500
    }
  },
  "slots": {
    "orders": {
      "columns": [
        {
          "name": "id",
          "type": "integer",
          "label": "单号"
        },
        {
          "name": "amount",
          "type": "decimal",
          "label": "金额"
        }
      ],
      "key": [
        "id"
      ],
      "max_rows": 100,
      "completeness": "all"
    }
  },
  "body": [
    {
      "id": "opening",
      "type": "cover",
      "title": [
        "订单月报 ",
        {
          "ref": {
            "scope": "parameter",
            "name": "period"
          }
        }
      ],
      "content": [
        {
          "ref": {
            "scope": "field",
            "name": "summary"
          }
        }
      ]
    },
    {
      "id": "detail",
      "type": "section",
      "title": [
        "明细"
      ],
      "children": [
        {
          "id": "order-table",
          "type": "data-view",
          "component": "table",
          "data": "orders",
          "props": {
            "columns": [
              "id",
              "amount"
            ]
          }
        }
      ]
    }
  ],
  "claims": [
    {
      "kind": "conclusion",
      "label": "结论",
      "min": 1,
      "max": 2
    }
  ],
  "responses": {
    "stances": [
      "agree",
      "dispute",
      "supplement"
    ],
    "reason_required": true
  },
  "gate": {
    "open_dispute_blocks_acceptance": false
  }
}
```

对象已有登记名称时，模板可声明可选字段 `subject_name`。提交报告时把登记名称放进 `inputs.fields.subject_name`，`subject` 继续用原始对象键。清单和报告页显示名称，悬停可看原键。

经 MCP 提交时，用有辨识度的会话名，例如「巡检日报席」。服务端按签发的会话确定产出方。分配给节点席位的会话用台名，取不到显示名时页面显示「未署名」。

## 2. 选择正文格式

v2 的 body 是有 id 的节点数组。第十二次上线起可用 v3：把 schema_version 设为 3，并把上面模板的 body 整体换成以下对象。root 指向 document，children 用元素名引用下级。元素键在整棵树内唯一，所有元素都要从根可达。

```json report-body-v3
{
  "root": "main",
  "elements": {
    "main": {
      "type": "document",
      "props": {},
      "children": [
        "summary",
        "ids",
        "order-table"
      ]
    },
    "summary": {
      "type": "text",
      "props": {
        "content": {
          "$concat": [
            "订单 ",
            {
              "$count": {
                "ref": {
                  "scope": "slot",
                  "name": "orders"
                }
              }
            },
            " 笔，达成率 ",
            {
              "$format": "percent",
              "locale": "zh-CN",
              "value": {
                "$math": "divide",
                "a": {
                  "$count": {
                    "ref": {
                      "scope": "slot",
                      "name": "orders"
                    }
                  }
                },
                "b": 10
              }
            },
            "。",
            {
              "ref": {
                "scope": "field",
                "name": "summary"
              }
            }
          ]
        }
      }
    },
    "ids": {
      "type": "text",
      "props": {
        "content": {
          "$join": {
            "ref": {
              "scope": "slot",
              "name": "orders",
              "column": "id"
            }
          },
          "separator": "、"
        }
      }
    },
    "order-table": {
      "type": "data-view",
      "props": {
        "component": "table",
        "data": "orders",
        "props": {
          "columns": [
            "id",
            "amount"
          ]
        }
      }
    }
  }
}
```

| 指令 | 写法和输入 |
| --- | --- |
| $format | 指定 date、number、percent 或 currency 和 value。可带 locale，currency 格式可带三字母币种。日期以 UTC 格式化。 |
| $count | 取列表或字符串长度。可直接引用整个槽计数。 |
| $join | 拼接列表。用 separator 指定分隔符，槽列引用返回该列的值列表。 |
| $concat | 拼接多个标量片段。可混用文字、引用和指令。 |
| $math | a 和可选 b 为数字表达式。支持 add、subtract、multiply、divide、mod、min、max，以及 round、floor、ceil、abs。 |

表达式在生成时由服务端根据经校验的输入和绑定槽求值，结果随报告冻结。预览不了的指令或取不到的字段、列需要回模板或绑定修正。浏览器展示已冻结结果。旧 v2 模板仍可使用，改模板或台数据不会改写已生成的报告。

### 图片

报告里放商品图、现场图这类图片，用 image 节点：`{ "id": …, "type": "image", "src": <一个引用>, "alt": <替代文字> }`。v3 的写法是元素 `type: "image"`，props 里放 src 和 alt。

**三种来源**（src 只能写一个引用，不能拼字）：

| 来源 | 写法 | 要求 |
| --- | --- | --- |
| 参数 | `{"ref":{"scope":"parameter","name":"hero"}}` | 模板里把这个参数声明成 `"type": "image"`，生成时传图片链接 |
| 字段 | `{"ref":{"scope":"field","name":"extra"}}` | 文字字段，生成时填的值要是合规的图片链接 |
| 行 | `{"ref":{"scope":"row","name":"pic"}}` | 只能放在 repeat 里，取当前行的一列；这一列在槽里要声明成 `"type": "image"`，绑定的视图也要出这一列 |

图片链接是 http(s) 链接，或图库里的相对路径（不以 / 开头、不含 ..），最长 2048 个字符。alt 必填，1～200 个字符，不能全是空白。

**格式**：只收 PNG、JPEG、WebP（GIF、SVG 不收）。单张不超过 5MB、4000 万像素，取图超过 10 秒算超时。

**冻结**：生成时服务端把每张图取一次，只把链接和 sha256 记进冻结正文，不存图片本身。取不到就不出报告：返回 `report_image_unavailable` 和代取的错误代号（对方断开或忙 503，超时 504，其余 400）。

**上限**：一份报告的图片节点按展开后计数（repeat 里每行算一张），现在最多 20 张；超了返回 `image_limit`。grid 里现在不能放 image（返回 `grid_split_unsupported`）。这两项在放宽中（issue #1081），以服务端实际返回为准。

**图片已变**：报告页经市场代取显示图片，按报告冻结的 sha256 核对。源图被换掉后，代取返回 409 `image_changed`，页面显示「图片已变」，不显示新图。要用新图就重新生成一份报告。

**出错时**：src 引用的参数或列不是 image 类型，返回 `image_source_type`；alt 不合规，返回 `invalid_alt`。来源的值不合规时，参数和字段与行不一样：

- 参数、字段：值不是合规链接返回 `invalid_image_ref`，没有值返回 `missing_reference`。
- 行：取回的格子在核数据时就先核过，不是合规链接或是空的，返回 `invalid_cell`（路径指到 `/slots/<槽>/rows/<行>/<列>`）。只有槽里把这一列声明成 `nullable`、格子是 null 时，才走到图片节点，返回 `missing_reference`。

以下模板为每个商品排一节：标题是商品名，下面是这一行的主图。槽 products 的 pic 列声明成 image，绑定时映射到视图里存图片链接的那一列。

```json report-template-v2
{
  "schema_version": 2,
  "title": "商品图册",
  "parameters": {
    "period": {
      "type": "month",
      "required": true
    }
  },
  "fields": {},
  "slots": {
    "products": {
      "columns": [
        {
          "name": "id",
          "type": "integer",
          "label": "编号"
        },
        {
          "name": "name",
          "type": "text",
          "label": "商品"
        },
        {
          "name": "pic",
          "type": "image",
          "label": "主图"
        }
      ],
      "key": [
        "id"
      ],
      "max_rows": 20,
      "completeness": "all"
    }
  },
  "body": [
    {
      "id": "cover",
      "type": "cover",
      "title": [
        "商品图册 ",
        {
          "ref": {
            "scope": "parameter",
            "name": "period"
          }
        }
      ]
    },
    {
      "id": "each",
      "type": "repeat",
      "data": "products",
      "row_key": [
        "id"
      ],
      "max_items": 20,
      "children": [
        {
          "id": "item",
          "type": "section",
          "title": [
            {
              "ref": {
                "scope": "row",
                "name": "name"
              }
            }
          ],
          "children": [
            {
              "id": "photo",
              "type": "image",
              "src": {
                "ref": {
                  "scope": "row",
                  "name": "pic"
                }
              },
              "alt": "商品主图"
            }
          ]
        }
      ]
    }
  ],
  "claims": [
    {
      "kind": "conclusion",
      "label": "结论",
      "min": 0,
      "max": 1
    }
  ],
  "responses": {
    "stances": [
      "agree",
      "dispute"
    ],
    "reason_required": true
  },
  "gate": {
    "open_dispute_blocks_acceptance": false
  }
}
```

repeat 的 max_items 和槽的 max_rows 要能容下全部行；行数乘以每行的图片数，不能超过上面的图片上限。

### 版式：结论先行

报告是给业务的人读的。打开第一屏就要看到结论和关键数，审计口吻不进正文。按下面的顺序排：

| 顺序 | 放什么 | 怎么写 |
|---|---|---|
| 1 封面 | 一句话结论：做不做、为什么 | `cover`，标题用 `$concat` 拼对象编号，正文取结论字段 |
| 2 关键数 | 读者不用往下翻的三四个数 | `grid` 选 `3-3-3-3`，放 `stat`，取只有一行的数据槽 |
| 3 理由与证据 | 理由、同类对比、原件 | `section` 里放 `text`、`bar`、`table` |
| 4 风险与下一步 | 谁、什么时候、做什么 | 必填文字字段，和 `claims` 里的风险、下一步对应 |
| 5 附录 | 口径、来源、版本 | 放在 `page-break` 之后；来源版本和摘要由平台记进报告的来源，正文不抄 |

几条做法：

- 槽对应的视图块用 `=` 精确筛出要的行，统计卡要求槽里恰好一行。
- 槽按 `max_rows` 取数，多一行整份报告就拒收。要「前 N 名」，由写入方先写一列名次，块再按名次 `<=` N 筛，做法见 wm-data-views 的 [数据视图设计指南](../wm-data-views/references/layout.md) 第八节。
- 正文的 `$format` 只能格式化参数、字段和计算结果。数据槽引用返回的是数组，要显示格式化的单个数，放进 `stat`。
- 报告里的 `table` 不支持 `value_labels`，代号会原样显示。给人看的取值要在写入时就写成说法，或者不放进报告表格。

## 3. 绑定台数据

先读当前模板和视图版本。以下 PUT /api/bench-views/<台>/reports/<维度>/binding 的示例假设首次绑定，生效模板为第 1 版，board 视图的第 2 块（block 从 0 算）返回 id 和 amount，筛选参数 month 已在该视图声明。

```json report-binding
{
  "base": 0,
  "slots": {
    "orders": {
      "view": "board",
      "block": 1,
      "params": {
        "month": {
          "ref": {
            "scope": "parameter",
            "name": "period"
          }
        }
      },
      "columns": {
        "id": "id",
        "amount": "amount"
      }
    }
  }
}
```

已有绑定时，用当前绑定版本填写 base。请求体只有 base 和 slots，绑定自动对到当前生效的模板，写 template_version 会被拒。更改槽来源遇到 409 时按 [停用与重绑](../wm-data-views/SKILL.md#保持报告绑定有效) 处理。生成前核生效模板和当前绑定是否对应。

## 4. 生成、查看和回应

在本台获授权后，用 `report_generate`。用本台和维度的实际标识替换下面示例，basis 中的 key 填槽内真实的主键值。来源版本、哈希和产出方由服务端记录。

```json report-generate
{
  "bench": "demo-orders",
  "dimension": "monthly-orders",
  "subject": "order:2026-11",
  "inputs": {
    "parameters": {
      "period": "2026-11"
    },
    "fields": {
      "summary": "本月订单情况。"
    }
  },
  "claims": [
    {
      "kind": "conclusion",
      "text": "已核对本月明细。",
      "basis": [
        {
          "slot": "orders",
          "key": [
            1
          ]
        }
      ]
    }
  ]
}
```

用 `report_list` 查已有报告，用 `report_get` 读一份。给人发链接时用市场卡片编号打开 `/use/<台>/reports?report=<编号>`，台首页也有「报告」入口。

用 `report_respond` 对论断或整份报告表态，正文选模板允许的立场并填理由。改变已有回应时接自己的链头，保留原回应和上下文。

## 5. 核对论断与更正报告

逐份打开冻结报告，按论断的 `basis` 回到这份报告的冻结行，核对主键、数值、来源和判断。几份报告即使模板相同，也要各自核证再写结论，避免沿用套话。

报告给出区间时，明确点估计在区间内还是区间外，并说明下界是否在零以下或恰为零，区间是否跨零。任何缺失的上下界写「未知」。缺失导致无法判断时，点估计的位置或跨零结论也写「未知」。例如合成点估计 0.20、区间 [-0.10, 0.35]，点估计在区间内，下界低于零，区间跨零。

发现报告错误时，通过 `report_generate` 用 `supersedes` 指向该链当前报告的编号，重新生成。核对新报告的编号、继承关系和冻结行，再告知使用者。旧报告仍可打开，原正文保持冻结。

## 6. 分三层验收

| 层 | 可核对的证据 |
| --- | --- |
| 结构 | 模板与槽契约检查结果、绑定读回版本、生成成功的报告编号。 |
| 内容 | 非作者逐份复核结论与冻结行的对应关系，留报告编号、引用行和通过或待修记录。 |
| 业务 | 属主对具体报告版本给出业务采纳结论，留确认回执。 |

按层留证。尚未完成的一层标为待验，并注明缺哪份回执。
