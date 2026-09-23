#!/usr/bin/env python3
"""Extract evaluator-group obligation identifiers from the OASIS OpenFormula 1.4 HTML.

Only names and section identifiers are stored. The specification text is not copied.
"""
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

URL = "https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html"
DEST = Path(__file__).resolve().parents[1] / "conformance" / "openformula-1.4-inventory.json"
source = Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else urllib.request.urlopen(URL).read().decode()

def section(n: int) -> str:
    start = source.index(f'<h3 class="Heading_20_3"><a id="a_2_3_{n}_')
    if n < 4:
        end = source.index(f'<h3 class="Heading_20_3"><a id="a_2_3_{n+1}_', start)
    else:
        end = source.index('<h2 class="Heading_20_2"><a id="a_2_4_', start)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", source[start:end])))

def pairs(segment: str) -> list[dict[str, str]]:
    found = re.findall(r"\b([A-Z][A-Z0-9.]*)\s+(6\.\d+\.\d+)", segment)
    names = [name for name, _ in found]
    if len(names) != len(set(names)):
        raise ValueError("duplicate function names in group")
    return [{"name": name, "section": ref} for name, ref in found]

small = section(2)
medium = section(3)
large = section(4)
small_functions = pairs(small[small.index("E)"):small.index("F)")])
medium_functions = pairs(medium[medium.index("A)"):medium.index("B)")])
large_functions = pairs(large[large.index("It shall implement the following functions"):large.index("Note:")])
assert (len(small_functions), len(medium_functions), len(large_functions)) == (110, 162, 116)

small_requirements = [
    ("limits.basic", "3.7"),
    ("syntax.criteria", "4.11.11"),
    ("syntax.basic-expressions", "5.2"),
    ("syntax.numbers", "5.3"),
    ("syntax.strings", "5.4"),
    ("syntax.operators", "5.5"),
    ("syntax.functions", "5.6"),
    ("syntax.nonstandard-functions", "5.7"),
    ("syntax.references", "5.8"),
    ("syntax.named-expressions", "5.11"),
    ("syntax.errors", "5.12"),
    ("syntax.whitespace", "5.14"),
    ("conversion.number", "6.3.5"),
    ("conversion.logical", "6.3.12"),
    ("conversion.text", "6.3.14"),
    ("conversion.reference", "6.3.2"),
    ("conversion.error", "6.3.1"),
    ("operator.comparison", "6.4.9"),
    ("operator.concat", "6.4.10"),
    ("operator.add", "6.4.2"),
    ("operator.subtract", "6.4.3"),
    ("operator.multiply", "6.4.4"),
    ("operator.divide", "6.4.5"),
    ("operator.power", "6.4.6"),
    ("operator.equal", "6.4.7"),
    ("operator.not-equal", "6.4.8"),
    ("operator.percent", "6.4.14"),
    ("operator.unary-plus", "6.4.15"),
    ("operator.unary-minus", "6.4.16"),
    ("operator.intersection", "6.4.12"),
    ("operator.range", "6.4.11"),
]
medium_requirements = [
    ("operator.union", "6.4.13"),
    ("references.multi-area", "5.9"),
]
large_requirements = [
    ("syntax.inline-arrays", "5.13"),
    ("syntax.automatic-intersection", "5.10.6"),
    ("syntax.external-names", "5.11"),
    ("types.complex", "4.4"),
    ("evaluation.array-formulas", "3.3"),
    ("syntax.sheet-local-names", "5.11"),
]

def group(name: str, functions: list[dict[str, str]], requirements: list[tuple[str, str]]) -> dict:
    return {
        "name": name,
        "functions": functions,
        "requirements": [{"id": key, "section": section} for key, section in requirements],
    }

inventory = {
    "standard": "OpenFormula 1.4",
    "source": URL,
    "conformanceSection": "2.3",
    "groups": [
        group("small", small_functions, small_requirements),
        group("medium", medium_functions, medium_requirements),
        group("large", large_functions, large_requirements),
    ],
}
DEST.write_text(json.dumps(inventory, indent=2) + "\n")
print(f"wrote {DEST}: 110 small, 162 medium, 116 large functions")
