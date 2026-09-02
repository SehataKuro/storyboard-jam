import { Cut, cutStartOf } from "./types";

const escapeJs = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");

/**
 * Builds an ExtendScript that imports the exported PNG sequence, creates a comp and
 * writes the cut switching timing as HOLD keyframes on Time Remap.
 * One exported image is exactly one source frame, so cut N maps to source time N/fps.
 */
export function buildAeScript(cuts: Cut[], options: { fps: number; width: number; height: number; projectName: string }) {
  const { fps, width, height, projectName } = options;
  const total = cuts.reduce((sum, cut) => sum + cut.duration, 0);
  const rows = cuts.map((cut, index) =>
    `  { name: "${escapeJs(cut.title)}", start: ${cutStartOf(cuts, index).toFixed(6)}, duration: ${cut.duration.toFixed(6)}, note: "${escapeJs(cut.note)}" }`,
  ).join(",\n");

  return `// CONTE LIVE -> After Effects
// After Effects で [ファイル > スクリプト > スクリプトファイルを実行] から実行してください。
// 書き出した連番PNGの1枚目を選ぶと、コンポとタイムリマップのキーを自動生成します。
(function () {
  var FPS = ${fps};
  var WIDTH = ${width};
  var HEIGHT = ${height};
  var TOTAL = ${total.toFixed(6)};
  var COMP_NAME = "${escapeJs(projectName)}";
  var CUTS = [
${rows}
  ];

  var first = File.openDialog("連番画像の1枚目（cut_0001.png）を選択してください");
  if (!first) { return; }

  app.beginUndoGroup("CONTE LIVE Import");
  try {
    var io = new ImportOptions(first);
    if (io.canImportAs(ImportAsType.FOOTAGE)) { io.importAs = ImportAsType.FOOTAGE; }
    io.sequence = true;
    io.forceAlphabetical = true;
    var sequence = app.project.importFile(io);
    try { sequence.mainSource.conformFrameRate = FPS; } catch (conformError) {}

    var comp = app.project.items.addComp(COMP_NAME, WIDTH, HEIGHT, 1.0, TOTAL, FPS);
    var layer = comp.layers.add(sequence);
    layer.startTime = 0;
    layer.timeRemapEnabled = true;

    var remap = layer.property("ADBE Time Remapping");
    while (remap.numKeys > 0) { remap.removeKey(1); }
    for (var i = 0; i < CUTS.length; i++) {
      remap.setValueAtTime(CUTS[i].start, i / FPS);
    }
    for (var k = 1; k <= remap.numKeys; k++) {
      remap.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
    }
    layer.outPoint = TOTAL;
    layer.name = COMP_NAME + " / cuts";

    // Cut titles and direction notes land on comp markers.
    for (var m = 0; m < CUTS.length; m++) {
      var marker = new MarkerValue(CUTS[m].name);
      marker.comment = CUTS[m].note;
      marker.duration = CUTS[m].duration;
      comp.markerProperty.setValueAtTime(CUTS[m].start, marker);
    }

    var audio = File.openDialog("音源ファイルを選択してください（不要ならキャンセル）");
    if (audio) {
      var audioItem = app.project.importFile(new ImportOptions(audio));
      comp.layers.add(audioItem);
    }

    comp.openInViewer();
    alert("CONTE LIVE: " + CUTS.length + "カットを読み込みました。");
  } catch (error) {
    alert("CONTE LIVE: 読み込みに失敗しました\\n" + error.toString());
  }
  app.endUndoGroup();
})();
`;
}

/** Human readable cut sheet shipped alongside the images. */
export function buildCutSheet(cuts: Cut[], fps: number) {
  const lines = cuts.map((cut, index) => {
    const start = cutStartOf(cuts, index);
    return [
      String(index + 1).padStart(4, "0"),
      `cut_${String(index + 1).padStart(4, "0")}.png`,
      cut.title,
      `${start.toFixed(3)}s`,
      `${cut.duration.toFixed(3)}s`,
      `frame ${Math.round(start * fps)}`,
      cut.note.replace(/[\r\n]+/g, " "),
    ].join("\t");
  });
  return ["No\tFile\tTitle\tStart\tDuration\tStartFrame\tNote", ...lines].join("\r\n");
}
