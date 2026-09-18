"""The tour points at real selectors.

A tour step whose target no longer exists silently degrades to a centred card
with nothing highlighted, which looks like a bug rather than a feature. These
assert every selector the tour names is still rendered somewhere.
"""

import pathlib
import re

import pytest

SRC = pathlib.Path(__file__).resolve().parents[1] / "frontend" / "src"
TOUR = SRC / "tour.js"


def _targets():
    text = TOUR.read_text(encoding="utf-8")
    out = []
    for m in re.finditer(r'target:\s*"([^"]+)"', text):
        out.extend(sel.strip() for sel in m.group(1).split(","))
    return out


def _all_component_source():
    return "\n".join(
        p.read_text(encoding="utf-8")
        for p in SRC.rglob("*.jsx")
    )


def test_tour_has_steps():
    assert len(_targets()) >= 8


@pytest.mark.parametrize("selector", _targets())
def test_every_tour_target_class_exists_in_a_component(selector):
    """Each selector is a class the JSX actually applies."""
    assert selector.startswith("."), f"unexpected selector form: {selector}"
    # ".pwa-bar.install" -> the last class is the distinguishing one.
    cls = selector.lstrip(".").split(".")[-1].split(" ")[-1]
    source = _all_component_source()
    assert cls in source, f"{selector} matches nothing in the components"


def test_step_ids_are_unique():
    ids = re.findall(r'id:\s*"([^"]+)"', TOUR.read_text(encoding="utf-8"))
    assert len(ids) == len(set(ids))


def test_every_step_has_a_title_and_body():
    text = TOUR.read_text(encoding="utf-8")
    ids = re.findall(r'id:\s*"([^"]+)"', text)
    assert len(re.findall(r"title:", text)) == len(ids)
    assert len(re.findall(r"body:", text)) == len(ids)
