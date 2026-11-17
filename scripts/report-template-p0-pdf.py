"""Optional local PDF evidence check. Uses an already-installed PyMuPDF; installs nothing.
Called by report-template-p0-browser.mjs --inspect-pdf. CI basic print tests do not require it.
"""

import json
import os
import re
import sys
import fitz

out = os.path.realpath(sys.argv[1])
results = []
for name in ("operating", "products", "next-period"):
    doc = fitz.open(os.path.join(out, name + ".pdf"))
    pages = [p.get_text() for p in doc]
    text = "\n".join(pages)
    a4 = all(
        abs(p.rect.width - 595.28) < 2 and abs(p.rect.height - 841.89) < 2 for p in doc
    )
    assert a4, (name, "not A4")
    assert len(pages) > 1, (name, "did not paginate")
    clipped = []
    for pn, page in enumerate(doc):
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    x0, y0, x1, y1 = span["bbox"]
                    if (
                        x0 < 52
                        or x1 > page.rect.width - 52
                        or y0 < 52
                        or y1 > page.rect.height - 52
                    ):
                        clipped.append(
                            {
                                "page": pn + 1,
                                "text": span["text"][:45],
                                "bbox": list(span["bbox"]),
                            }
                        )
    assert not clipped, (name, "text outside 20mm content box", clipped[:5])
    if name != "products":
        ids = re.findall(r"ROW[0-9]{4}", text)
        assert ids == ["ROW" + str(i + 1).zfill(4) for i in range(308)], (
            name,
            len(ids),
            ids[:3],
            ids[-3:],
        )
        assert "END308" in text, (name, "missing tail")
        missing_header = [
            i + 1
            for i, t in enumerate(pages)
            if re.search(r"ROW[0-9]{4}", t) and "CNY" not in t
        ]
        assert not missing_header, (name, "missing repeated header", missing_header)
        summary = {"rows": len(ids), "row_order_exact": True, "repeated_headers": True}
    else:
        ids = re.findall(r"SKU[0-9]{4}", text)
        assert ids == ["SKU" + str(i + 1).zfill(4) for i in range(50)], (
            name,
            len(ids),
            ids[:3],
            ids[-3:],
        )
        assert "END50" in text, (name, "missing product tail")
        for i, page in enumerate(doc):
            images = [
                b["bbox"] for b in page.get_text("dict")["blocks"] if b["type"] == 1
            ]
            matches = [
                (m, page.search_for(m)[0]) for m in re.findall(r"SKU[0-9]{4}", pages[i])
            ]
            for j, (sku, rect) in enumerate(matches):
                end = matches[j + 1][1].y0 if j + 1 < len(matches) else page.rect.height
                assert any(rect.y0 < image[1] < end for image in images), (
                    name,
                    "section leader separated from its image",
                    i + 1,
                    sku,
                )
        summary = {
            "products": len(ids),
            "product_order_exact": True,
            "section_leaders_with_image": True,
        }
    render_pages = sorted(set([0, min(1, len(doc) - 1), len(doc) // 2, len(doc) - 1]))
    for pn in render_pages:
        doc[pn].get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False).save(
            os.path.join(out, name + "-page-" + str(pn + 1) + ".png")
        )
    results.append(
        {
            "sample": name,
            "pages": len(pages),
            "a4": True,
            "text_within_content_box": True,
            **summary,
            "rendered_pages": [p + 1 for p in render_pages],
        }
    )
    print("PDF_PASS", results[-1])
    doc.close()
with open(os.path.join(out, "pdf-results.json"), "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print(
    "report-template-p0-pdf: content order, all rows/products, A4, repeated headers and text bounds passed"
)
