"""Line starts on a scanned page: the first ink cluster of each line, specks and shadow ignored."""
import unittest

import numpy as np

from ocr.scan_line_starts import line_starts, parse_pages, text_block


def page(width=1000, height=1400):
    return np.full((height, width), 255, dtype=np.uint8)


class LineStarts(unittest.TestCase):
    def test_pages_spec(self):
        self.assertEqual(parse_pages("23-25,27"), [23, 24, 25, 27])

    def test_the_binding_side_follows_the_page(self):
        self.assertEqual(text_block(1000, 23), (120, 950))   # right-hand page: shadow on the left
        self.assertEqual(text_block(1000, 24), (50, 820))    # left-hand page: outer margin on the right

    def test_a_number_then_text_starts_at_the_number(self):
        gray = page()
        gray[300:320, 300:310] = 0      # "1." at the margin
        gray[300:320, 330:700] = 0      # the line's text, after a gap
        gray[300:302, 200:201] = 0      # a speck before the margin: not a line start
        gray[:, 10:40] = 60             # the binding shadow, outside the text block
        [(x0, y0, x1, y1)] = line_starts(gray, page=23)
        self.assertEqual(x0, 300)
        self.assertLessEqual(x1, 312)
        self.assertEqual((y0, y1), (300, 320))

    def test_a_start_is_never_wider_than_a_two_digit_number(self):
        gray = page()
        gray[500:520, 300:800] = 0      # one long run of ink
        [(x0, _, x1, _)] = line_starts(gray, page=23)
        self.assertLessEqual(x1 - x0, int(1.4 * 20))


if __name__ == "__main__":
    unittest.main()
