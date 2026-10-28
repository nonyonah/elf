"""Build the native single-color mascot glyph. Build-time only: pip install fonttools."""
from pathlib import Path
import xml.etree.ElementTree as ET
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parent.parent
pen = TTGlyphPen(None)
curves = Cu2QuPen(pen, max_err=1)
transformed = TransformPen(curves, (40, 0, 0, -40, 20, 960))
for path_index, element in enumerate(ET.parse(root / 'extension/media/elf.svg').getroot()):
    recording = RecordingPen()
    parse_path(element.attrib['d'], recording)
    contour = RecordingPen()
    contour_index = 0
    for operation, arguments in recording.value:
        getattr(contour, operation)(*arguments)
        if operation in ('closePath', 'endPath'):
            # SVG uses evenodd: reverse the two eye holes for font winding.
            target = ReverseContourPen(transformed) if path_index == 1 and contour_index > 0 else transformed
            contour.replay(target)
            contour = RecordingPen()
            contour_index += 1
builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder(['.notdef', 'elfMascot'])
builder.setupCharacterMap({0xE001: 'elfMascot'})
builder.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), 'elfMascot': pen.glyph()})
builder.setupHorizontalMetrics({'.notdef': (1000, 0), 'elfMascot': (1000, 0)})
builder.setupHorizontalHeader(ascent=1000, descent=0)
builder.setupNameTable({'familyName': 'Elf Mascot', 'styleName': 'Regular', 'uniqueFontIdentifier': 'ElfMascot-Regular-1', 'fullName': 'Elf Mascot Regular', 'psName': 'ElfMascot-Regular', 'version': 'Version 1.0'})
builder.setupOS2(sTypoAscender=1000, sTypoDescender=0, usWinAscent=1000, usWinDescent=0)
builder.setupPost()
builder.font.flavor = 'woff'
builder.font.save(root / 'extension/media/elf-mascot.woff')
print('Native Elf mascot icon font built.')
