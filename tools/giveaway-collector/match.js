// Keep identical to isExactCommand in giveaway/draw-math.js.
function isExactCommand(value) {
  if (typeof value !== "string") return false;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toLowerCase();
  return cleaned === "!gta6";
}

module.exports = { isExactCommand };
