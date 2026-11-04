"""Clip windows of pages built by clipping an embedded page (the 2024 留白 books)."""
import unittest

from ocr.clip_windows import page_layout, page_windows, window_forms, without_forms

# The page content PyMuPDF's show_pdf_page writes, verbatim in shape, as on page
# 11 of the 2024 algebra exercise book: a running head, then two clipped forms.
PAGE_11 = """q
1 0 0 1 0 0 cm  BT /F1 12 Tf 14.4 TL ET
BT 1 0 0 1 56.69 812.89 Tm /F2 8.5 Tf 10.2 TL (head) Tj T* ET
Q

q
1 0.0 0.0 1 56.69 576.32 cm
0.0 0.0 444 31.25 re
W
n
q
0 0 444 31.25 re
W
n
q
/fzFrm0 Do
Q
0 g
0 G
Q
Q

q
1 0.0 0.0 1 56.69 264.05 cm
0.0 0.0 444 66 re
W
n
q
0 0 444 66 re
W
n
q
/fzFrm0-0 Do
Q
Q
Q
"""


class _Box:
    def __init__(self, height):
        self.height = height


class _Stream:
    def __init__(self, text):
        self._data = text.encode("latin-1")

    def get_data(self):
        return self._data


class _Page:
    def __init__(self, text, height=841.89, forms=None):
        self._contents = _Stream(text) if text is not None else None
        self.mediabox = _Box(height)
        self._forms = forms

    def get_contents(self):
        return self._contents

    def get(self, key):
        if key != "/Resources" or self._forms is None:
            return None
        return _Obj({"/XObject": {"/" + name: _Obj(form) for name, form in self._forms.items()}})


class _Obj(dict):
    def get_object(self):
        return self


# Page 177 of the 2024 algebra exercise book: one window showing a question
# that runs over two original pages, as two forms each cut by its own /BBox.
PAGE_177 = """q
1 0.0 0.0 1 56.69 529.01 cm
0.0 0.0 444 103.25 re
W
n
q
0 0 444 103.25 re
W
n
q
/fzFrm0 Do
Q
q
/fzFrm1 Do
Q
0 g
0 G
Q
Q
"""
FORMS_177 = {
    "fzFrm0": {"/BBox": [36.0, 50.81, 480.0, 138.06], "/Matrix": [1, 0, 0, 1, -36.0, -34.81]},
    "fzFrm1": {"/BBox": [36.0, 638.16, 480.0, 652.16], "/Matrix": [1, 0, 0, 1, -36.0, -638.16]},
}


class ClipWindows(unittest.TestCase):
    def test_windows_in_top_left_points(self):
        windows = page_windows(_Page(PAGE_11))
        self.assertEqual(windows, [[56.69, 234.32, 500.69, 265.57], [56.69, 511.84, 500.69, 577.84]])

    def test_a_page_without_clipped_forms_has_no_windows(self):
        self.assertEqual(page_windows(_Page("q BT /F1 12 Tf (x) Tj ET Q")), [])
        self.assertEqual(page_windows(_Page(None)), [])

    def test_an_empty_content_stream_is_not_mistaken_for_none(self):
        # pypdf content streams are dictionaries; an empty one is falsy.
        class Falsy(_Stream):
            def __bool__(self):
                return False
        page = _Page(None)
        page._contents = Falsy(PAGE_11)
        self.assertEqual(len(page_windows(page)), 2)

    def test_a_window_owns_every_form_drawn_inside_its_clip(self):
        # Page 15 of the 2024 algebra book: one window, two embedded pages.
        two = PAGE_11.replace("/fzFrm0 Do\nQ\n0 g", "/fzFrm0 Do\nQ\nq\n/fzFrm1 Do\nQ\n0 g")
        self.assertEqual(window_forms(two), [["fzFrm0", "fzFrm1"], ["fzFrm0-0"]])

    def test_each_form_paints_only_its_own_part_of_the_window(self):
        # The second form's text that falls in the first form's part is hidden;
        # read as printed, it put a section heading into the window as a
        # formula region, and the model read the crop as blank.
        [window] = page_layout(_Page(PAGE_177, forms=FORMS_177))
        self.assertEqual(window["rect"], [56.69, 209.63, 500.69, 312.88])
        self.assertEqual([(p["form"], p["rect"]) for p in window["parts"]],
                         [("fzFrm0", [56.69, 209.63, 500.69, 296.88]),
                          ("fzFrm1", [56.69, 298.88, 500.69, 312.88])])

    def test_a_form_whose_box_misses_the_window_shows_nothing(self):
        forms = dict(FORMS_177, fzFrm1={"/BBox": [36.0, 900.0, 480.0, 950.0], "/Matrix": [1, 0, 0, 1, 0, 0]})
        [window] = page_layout(_Page(PAGE_177, forms=forms))
        self.assertIsNone(window["parts"][1]["rect"])

    def test_a_transform_between_clip_and_form_is_not_guessed(self):
        moved = PAGE_177.replace("q\n/fzFrm1 Do", "q\n1 0 0 1 0 -50 cm\n/fzFrm1 Do")
        self.assertIsNone(page_layout(_Page(moved, forms=FORMS_177)))

    def test_a_copy_keeps_exactly_one_form(self):
        spans = [p["span"] for w in page_layout(_Page(PAGE_11)) for p in w["parts"]]
        only = without_forms(PAGE_11, spans, keep=spans[1])
        self.assertNotIn("/fzFrm0 Do", only)
        self.assertIn("/fzFrm0-0 Do", only)
        native = without_forms(PAGE_11, spans)
        self.assertNotIn(" Do", native)
        self.assertIn("(head) Tj", native)

if __name__ == "__main__":
    unittest.main()
