// Weighted wheel geometry. Labels are kept only when a slice is wide enough
// and far enough from the previous label that the names cannot overlap.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GiveawayWheel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TAU = Math.PI * 2;
  const MIN_LABEL_ARC = 0.22;
  const MIN_GAP = 0.22;

  function weightOf(row) {
    if (row && Number.isInteger(row.weight) && row.weight > 0) return row.weight;
    if (row && Number.isInteger(row.entries) && row.entries > 0) return row.entries;
    return 0;
  }

  function angularDistance(a, b) {
    const span = Math.abs(a - b) % TAU;
    return Math.min(span, TAU - span);
  }

  function layoutSlices(list, winnerKey) {
    const rows = [];
    const source = Array.isArray(list) ? list : [];
    for (let index = 0; index < source.length; index++) {
      const row = source[index];
      const weight = weightOf(row);
      if (!weight) continue;
      rows.push({
        key: row && row.key ? row.key : (row && row.handle) || String(index),
        handle: (row && (row.handle || row.displayName)) || "—",
        platform: (row && row.platform) || "",
        weight: weight,
      });
    }
    const total = rows.reduce((sum, row) => sum + row.weight, 0) || 1;
    let cursor = 0;
    const slices = rows.map((row) => {
      const arc = (row.weight / total) * TAU;
      const start = cursor;
      const end = cursor + arc;
      cursor = end;
      return {
        key: row.key,
        handle: row.handle,
        platform: row.platform,
        weight: row.weight,
        start: start,
        end: end,
        mid: start + arc / 2,
        arc: arc,
        label: false,
        winner: Boolean(winnerKey) && row.key === winnerKey,
      };
    });
    const order = [];
    for (let index = 0; index < slices.length; index++) {
      if (slices[index].arc >= MIN_LABEL_ARC) order.push(index);
    }
    order.sort((a, b) => slices[b].arc - slices[a].arc);
    const placed = [];
    for (let i = 0; i < order.length; i++) {
      const index = order[i];
      let clear = true;
      for (let j = 0; j < placed.length; j++) {
        if (angularDistance(slices[placed[j]].mid, slices[index].mid) < MIN_GAP) {
          clear = false;
          break;
        }
      }
      if (clear) {
        slices[index].label = true;
        placed.push(index);
      }
    }
    return slices;
  }

  function sliceAt(slices, pointerFromTop) {
    if (!slices || !slices.length) return null;
    let point = pointerFromTop % TAU;
    if (point < 0) point += TAU;
    for (let index = 0; index < slices.length; index++) {
      if (point >= slices[index].start && point < slices[index].end) return slices[index];
    }
    return slices[slices.length - 1];
  }

  function pointerFromRotation(angle) {
    let turn = angle % TAU;
    if (turn < 0) turn += TAU;
    return (TAU - turn) % TAU;
  }

  function landingRotation(mid) {
    let point = mid % TAU;
    if (point < 0) point += TAU;
    return (TAU - point) % TAU + 6 * TAU;
  }

  return {
    MIN_LABEL_ARC: MIN_LABEL_ARC,
    MIN_GAP: MIN_GAP,
    weightOf: weightOf,
    angularDistance: angularDistance,
    layoutSlices: layoutSlices,
    sliceAt: sliceAt,
    pointerFromRotation: pointerFromRotation,
    landingRotation: landingRotation,
  };
});
