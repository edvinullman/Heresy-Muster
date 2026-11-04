// Heresy Muster → InDesign
// Places an army sheet exported from Heresy Muster into the active document.
//
// The document needs:
//   - a text frame with the Script Label "ArmyList" (Window › Utilities › Script Label),
//     threaded to as many frames as the sheet should flow through. If none is labelled,
//     the selected text frame is used.
//   - optional text frames labelled "ArmyTitle", "ArmySubtitle", "ArmyAuthor", "ArmyEvent".
//   - the paragraph styles named in the export (HM Unit Heading, HM Unit Line, …).
//     Missing styles are created on place, so they show up in the Paragraph Styles panel.
//
// Unit images: pick a folder holding one image per unit, named after the unit's datasheet
// name (e.g. "Phoenix Terminators.psd"). Each one is placed inline in the empty
// "HM Unit Image" paragraph above its unit. Cancel the folder dialog to skip images.

#target indesign

(function () {
  if (!app.documents.length) { alert('Open the army sheet template first.'); return; }
  var doc = app.activeDocument;

  var txt = File.openDialog('Choose the army .txt exported from Heresy Muster', '*.txt');
  if (!txt) return;
  var data = null;
  var json = File(txt.fullName.replace(/\.txt$/i, '.json'));
  if (json.exists) {
    json.encoding = 'UTF-8';
    json.open('r'); var src = json.read(); json.close();
    try { data = eval('(' + src + ')'); } catch (e) { data = null; }
  }

  function labelled(name) {
    var items = doc.allPageItems;
    for (var i = 0; i < items.length; i++) if (items[i].label === name) return items[i];
    return null;
  }

  var frame = labelled('ArmyList');
  if (!frame && app.selection.length && app.selection[0].constructor.name === 'TextFrame') frame = app.selection[0];
  if (!frame) { alert('Label a text frame "ArmyList" (Window › Utilities › Script Label), or select one, then run again.'); return; }

  // Replace the story's contents with the export.
  var story = frame.parentStory;
  story.contents = '';
  frame.insertionPoints[0].place(txt, false);

  if (data) {
    var fields = { ArmyTitle: data.title, ArmySubtitle: data.subtitle, ArmyAuthor: data.author, ArmyEvent: data.event };
    for (var key in fields) {
      var f = labelled(key);
      if (f && fields[key]) f.parentStory.contents = fields[key];
    }
  }

  // Unit images.
  if (data && data.units && data.units.length) {
    var folder = Folder.selectDialog('Choose the folder with unit images (Cancel to skip)');
    if (folder) {
      var exts = ['.psd', '.png', '.tif', '.tiff', '.ai', '.eps', '.pdf', '.jpg', '.jpeg'];
      var find = function (base) {
        for (var e = 0; e < exts.length; e++) { var file = File(folder.fullName + '/' + base + exts[e]); if (file.exists) return file; }
        return null;
      };
      var oldUnits = app.scriptPreferences.measurementUnit;
      app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
      var paras = story.paragraphs;
      var slots = [];
      for (var i = 0; i < paras.length; i++) if (paras[i].appliedParagraphStyle.name === 'HM Unit Image') slots.push(i);
      var missing = [];
      // Work backwards so inserting graphics doesn't shift paragraphs still to visit.
      for (var s = slots.length - 1; s >= 0; s--) {
        var unit = data.units[s];
        if (!unit) continue;
        var img = find(unit.image);
        if (!img) { missing.push(unit.image); continue; }
        var ip = story.paragraphs[slots[s]].insertionPoints[0];
        var rect = ip.rectangles.add({ geometricBounds: [0, 0, 30, 60] });
        rect.place(img);
        rect.fit(FitOptions.PROPORTIONALLY);
        rect.fit(FitOptions.FRAME_TO_CONTENT);
      }
      app.scriptPreferences.measurementUnit = oldUnits;
      if (missing.length) alert('No image found for:\n' + missing.reverse().join('\n'));
    }
  }

  if (story.overflows) alert('The sheet overflows its frames. Thread more frames to the "ArmyList" frame.');
})();
