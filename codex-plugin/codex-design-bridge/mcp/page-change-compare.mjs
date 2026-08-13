const STRUCTURAL_PROPERTIES = new Set([
  "pageSeed",
  "nodeClone",
  "nodeInsert",
  "nodeMove",
  "nodeReparent",
  "nodeReorder",
  "nodeDelete",
  "svgInsert",
]);

const UNSUPPORTED = Symbol("unsupported-page-property");
const NUMBER_TOLERANCE = 0.75;
const SAFE_NODE_PROPERTIES = new Set([
  "fill",
  "stroke",
  "opacity",
  "visible",
  "cornerRadius",
  "characters",
]);

export function collectCreatedPageNodeIds(changes) {
  const ids = new Set();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (change?.property === "nodeClone") {
      for (const mapping of change?.to?.idMap || []) {
        if (typeof mapping?.to === "string" && mapping.to) ids.add(mapping.to);
      }
      continue;
    }
    if (["nodeInsert", "pageSeed"].includes(change?.property)) {
      collectDefinitionIds(change?.to?.node, ids);
    }
  }
  return ids;
}

export function assessStalePageChange({
  change,
  baselineManifest = null,
  currentManifest = null,
  createdNodeIds = new Set(),
}) {
  if (!currentManifest?.root) {
    return { ok: false, reason: "current_page_unavailable" };
  }
  if (!change || typeof change !== "object") {
    return { ok: false, reason: "invalid_change" };
  }

  if (
    createdNodeIds.has(change.nodeId) &&
    !STRUCTURAL_PROPERTIES.has(change.property)
  ) {
    return { ok: true };
  }

  if (STRUCTURAL_PROPERTIES.has(change.property)) {
    return assessStructuralChange(change, baselineManifest, currentManifest);
  }
  if (!SAFE_NODE_PROPERTIES.has(change.property)) {
    return { ok: false, reason: "stale_property_unverifiable" };
  }

  const current = findManifestNode(currentManifest.root, change.nodeId);
  if (!current) {
    return { ok: false, reason: "source_target_missing" };
  }

  const currentValue = manifestPropertyValue(current.node, change.property);
  if (currentValue === UNSUPPORTED) {
    return { ok: false, reason: "stale_property_unverifiable" };
  }

  const baseline = baselineManifest?.root
    ? findManifestNode(baselineManifest.root, change.nodeId)
    : null;
  if (baseline) {
    const baselineValue = manifestPropertyValue(
      baseline.node,
      change.property,
    );
    if (baselineValue === UNSUPPORTED) {
      return { ok: false, reason: "stale_property_unverifiable" };
    }
    return valuesEquivalent(
      change.property,
      baselineValue,
      currentValue,
      baseline.node,
      current.node,
    )
      ? { ok: true }
      : { ok: false, reason: "source_target_changed" };
  }

  return valuesEquivalent(
    change.property,
    change.from,
    currentValue,
    current.node,
    current.node,
  )
    ? { ok: true }
    : { ok: false, reason: "source_target_changed" };
}

export function verifyPageChange(manifest, change) {
  if (!manifest?.root || !change || typeof change !== "object") {
    return { supported: false, ok: false, reason: "invalid_verification" };
  }
  const located = findManifestNode(manifest.root, change.nodeId);

  if (change.property === "nodeDelete") {
    return located
      ? { supported: true, ok: false, reason: "deleted_node_present" }
      : { supported: true, ok: true };
  }
  if (change.property === "visible" && change.to === false && !located) {
    return { supported: true, ok: true };
  }
  if (!located) {
    return { supported: true, ok: false, reason: "verification_node_missing" };
  }

  if (change.property === "nodeInsert" || change.property === "pageSeed") {
    const expectedIds = new Set();
    collectDefinitionIds(change?.to?.node, expectedIds);
    const missing = [...expectedIds].find(
      (nodeId) => !findManifestNode(manifest.root, nodeId),
    );
    return missing
      ? {
          supported: true,
          ok: false,
          reason: "inserted_node_missing",
          nodeId: missing,
        }
      : { supported: expectedIds.size > 0, ok: expectedIds.size > 0 };
  }

  if (change.property === "nodeClone") {
    const expectedIds = (change?.to?.idMap || [])
      .map((mapping) => mapping?.to)
      .filter(Boolean);
    const missing = expectedIds.find(
      (nodeId) => !findManifestNode(manifest.root, nodeId),
    );
    return missing
      ? {
          supported: true,
          ok: false,
          reason: "cloned_node_missing",
          nodeId: missing,
        }
      : { supported: expectedIds.length > 0, ok: expectedIds.length > 0 };
  }

  if (["nodeMove", "nodeReparent"].includes(change.property)) {
    if (located.parent?.id !== change.toParentId) {
      return { supported: true, ok: false, reason: "parent_mismatch" };
    }
    const index = located.parent.children.indexOf(located.node);
    if (index !== change.toIndex) {
      return { supported: true, ok: false, reason: "order_mismatch" };
    }
    if (change.afterBounds) {
      const error = Math.max(
        Math.abs(located.node.x - change.afterBounds.x),
        Math.abs(located.node.y - change.afterBounds.y),
      );
      if (error > 2) {
        return {
          supported: true,
          ok: false,
          reason: "geometry_mismatch",
          error,
        };
      }
      return { supported: true, ok: true, positionError: error };
    }
    return { supported: true, ok: true };
  }

  if (change.property === "nodeReorder") {
    const expected = (change?.to?.children || [])
      .map((child) => child?.nodeId)
      .filter(Boolean);
    if (expected.length === 0 || !Array.isArray(located.node.children)) {
      return { supported: false, ok: false, reason: "reorder_unverifiable" };
    }
    const expectedSet = new Set(expected);
    const actual = located.node.children
      .map((child) => child.id)
      .filter((nodeId) => expectedSet.has(nodeId));
    return arraysEqual(actual, expected)
      ? { supported: true, ok: true }
      : { supported: true, ok: false, reason: "order_mismatch" };
  }

  if (STRUCTURAL_PROPERTIES.has(change.property) || change.property === "svg") {
    return { supported: false, ok: false, reason: "property_unverifiable" };
  }
  if (!SAFE_NODE_PROPERTIES.has(change.property)) {
    return { supported: false, ok: false, reason: "property_unverifiable" };
  }

  const actual = manifestPropertyValue(located.node, change.property);
  if (actual === UNSUPPORTED) {
    return { supported: false, ok: false, reason: "property_unverifiable" };
  }
  return valuesEquivalent(
    change.property,
    change.to,
    actual,
    located.node,
    located.node,
  )
    ? { supported: true, ok: true }
    : { supported: true, ok: false, reason: "value_mismatch" };
}

export function findManifestNode(root, nodeId, parent = null) {
  if (!root || typeof nodeId !== "string") return null;
  if (root.id === nodeId) return { node: root, parent };
  for (const child of root.children || []) {
    const found = findManifestNode(child, nodeId, root);
    if (found) return found;
  }
  return null;
}

function assessStructuralChange(change, baselineManifest, currentManifest) {
  if (!baselineManifest?.root) {
    return { ok: false, reason: "stale_structure_requires_baseline" };
  }
  if (change.property === "pageSeed") {
    return { ok: false, reason: "stale_page_seed" };
  }

  const baseline = findManifestNode(baselineManifest.root, change.nodeId);
  const current = findManifestNode(currentManifest.root, change.nodeId);

  if (change.property === "nodeDelete") {
    if (!baseline || !current) {
      return { ok: false, reason: "source_target_missing" };
    }
    return nodeFingerprint(baseline.node) === nodeFingerprint(current.node)
      ? { ok: true }
      : { ok: false, reason: "source_target_changed" };
  }

  if (["nodeMove", "nodeReparent"].includes(change.property)) {
    const targetParent = findManifestNode(
      currentManifest.root,
      change.toParentId,
    );
    if (!baseline || !current || !targetParent) {
      return { ok: false, reason: "source_structure_changed" };
    }
    const baselineIndex = baseline.parent?.children?.indexOf(baseline.node);
    const currentIndex = current.parent?.children?.indexOf(current.node);
    return baseline.parent?.id === current.parent?.id &&
      baselineIndex === currentIndex
      ? { ok: true }
      : { ok: false, reason: "source_structure_changed" };
  }

  if (["nodeInsert", "nodeReorder", "svgInsert"].includes(change.property)) {
    if (!baseline || !current) {
      return { ok: false, reason: "source_structure_changed" };
    }
    return arraysEqual(directChildIds(baseline.node), directChildIds(current.node))
      ? { ok: true }
      : { ok: false, reason: "source_structure_changed" };
  }

  if (change.property === "nodeClone") {
    const sourceId = change?.from?.nodeId || change.nodeId;
    const baselineSource = findManifestNode(baselineManifest.root, sourceId);
    const currentSource = findManifestNode(currentManifest.root, sourceId);
    if (!baselineSource || !currentSource) {
      return { ok: false, reason: "source_target_missing" };
    }
    return nodeFingerprint(baselineSource.node) ===
      nodeFingerprint(currentSource.node)
      ? { ok: true }
      : { ok: false, reason: "source_target_changed" };
  }

  return { ok: false, reason: "stale_structure_unverifiable" };
}

function manifestPropertyValue(node, property) {
  switch (property) {
    case "fill":
      return node.style?.fill ?? null;
    case "stroke":
      return node.style?.stroke ?? null;
    case "strokeWeight":
      return node.style?.strokeWidth ?? uniformStrokeWidth(node.style) ?? 0;
    case "opacity":
    case "visible":
    case "x":
    case "y":
    case "width":
    case "height":
    case "rotation":
      return node[property];
    case "cornerRadius":
      return node.style?.radius ?? 0;
    case "characters":
      return node.type === "text" ? node.text : UNSUPPORTED;
    case "fontName":
      return node.type === "text"
        ? { family: node.font?.family, style: node.font?.style }
        : UNSUPPORTED;
    case "fontSize":
      return node.type === "text" ? node.font?.size : UNSUPPORTED;
    case "lineHeight":
      return node.type === "text"
        ? { unit: "PIXELS", value: node.font?.lineHeight }
        : UNSUPPORTED;
    case "letterSpacing":
      return node.type === "text"
        ? { unit: "PIXELS", value: node.font?.letterSpacing }
        : UNSUPPORTED;
    case "textAlignHorizontal":
      return node.type === "text"
        ? String(node.textAlign || "left").toUpperCase().replace("JUSTIFY", "JUSTIFIED")
        : UNSUPPORTED;
    case "layoutKind":
      return node.type === "frame" ? node.layout?.kind : UNSUPPORTED;
    case "layoutMode":
      return node.type === "frame"
        ? ({ horizontal: "HORIZONTAL", vertical: "VERTICAL", none: "NONE" }[
            node.layout?.direction
          ] || "NONE")
        : UNSUPPORTED;
    case "layoutWrap":
      return node.type === "frame"
        ? node.layout?.wrap
          ? "WRAP"
          : "NO_WRAP"
        : UNSUPPORTED;
    case "itemSpacing":
      return node.type === "frame" ? node.layout?.gap : UNSUPPORTED;
    case "counterAxisSpacing":
      return node.type === "frame" ? node.layout?.counterGap : UNSUPPORTED;
    case "padding":
      return node.type === "frame" ? node.layout?.padding : UNSUPPORTED;
    case "primaryAxisAlignItems":
      return node.type === "frame"
        ? axisAlignment(node.layout?.justify, true)
        : UNSUPPORTED;
    case "counterAxisAlignItems":
      return node.type === "frame"
        ? axisAlignment(node.layout?.align, false)
        : UNSUPPORTED;
    case "primaryAxisSizingMode":
      return node.type === "frame"
        ? node.layout?.primarySizing === "hug"
          ? "AUTO"
          : "FIXED"
        : UNSUPPORTED;
    case "counterAxisSizingMode":
      return node.type === "frame"
        ? node.layout?.counterSizing === "hug"
          ? "AUTO"
          : "FIXED"
        : UNSUPPORTED;
    case "layoutAlign":
      return node.layoutItem
        ? node.layoutItem.align === "stretch"
          ? "STRETCH"
          : "INHERIT"
        : "INHERIT";
    case "layoutGrow":
      return node.layoutItem?.grow ?? 0;
    case "layoutPositioning":
      return node.layoutItem?.positioning === "absolute" ? "ABSOLUTE" : "AUTO";
    case "layoutSizingHorizontal":
      return String(node.layoutItem?.horizontalSizing || "fixed").toUpperCase();
    case "layoutSizingVertical":
      return String(node.layoutItem?.verticalSizing || "fixed").toUpperCase();
    default:
      return UNSUPPORTED;
  }
}

function valuesEquivalent(property, expected, actual, expectedNode, actualNode) {
  if (["fill", "stroke"].includes(property)) {
    return arraysEqual(canonicalPaint(expected), canonicalPaint(actual), 1 / 255);
  }
  if (["lineHeight", "letterSpacing"].includes(property)) {
    const expectedPixels = unitValuePixels(expected, expectedNode, property);
    const actualPixels = unitValuePixels(actual, actualNode, property);
    return numberEquivalent(expectedPixels, actualPixels);
  }
  return deepEquivalent(expected, actual);
}

function canonicalPaint(value) {
  if (value === null || value === undefined || value === "transparent") {
    return null;
  }
  let color = value;
  let opacity = 1;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    color = value.color;
    opacity = Number.isFinite(value.opacity) ? value.opacity : 1;
  }
  const match = String(color || "").match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) return UNSUPPORTED;
  const channels = [0, 2, 4].map(
    (index) => Number.parseInt(match[1].slice(index, index + 2), 16) / 255,
  );
  const embeddedAlpha = match[2]
    ? Number.parseInt(match[2], 16) / 255
    : 1;
  return [...channels, embeddedAlpha * opacity];
}

function unitValuePixels(value, node, property) {
  if (Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return UNSUPPORTED;
  if (value.unit === "PIXELS" && Number.isFinite(value.value)) {
    return value.value;
  }
  if (value.unit === "PERCENT" && Number.isFinite(value.value)) {
    const fontSize = node?.font?.size;
    return Number.isFinite(fontSize) ? (fontSize * value.value) / 100 : UNSUPPORTED;
  }
  if (value.unit === "AUTO" && property === "lineHeight") {
    return UNSUPPORTED;
  }
  return UNSUPPORTED;
}

function deepEquivalent(left, right) {
  if (left === UNSUPPORTED || right === UNSUPPORTED) return false;
  if (Number.isFinite(left) || Number.isFinite(right)) {
    return numberEquivalent(left, right);
  }
  if (left === null || right === null || left === undefined || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      arraysEqual(left, right);
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEquivalent(left[key], right[key])) return false;
  }
  return true;
}

function arraysEqual(left, right, tolerance = null) {
  if (left === UNSUPPORTED || right === UNSUPPORTED) return false;
  if (left === null || right === null) return left === right;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) =>
    tolerance === null
      ? deepEquivalent(value, right[index])
      : Math.abs(value - right[index]) <= tolerance,
  );
}

function numberEquivalent(left, right) {
  return Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= NUMBER_TOLERANCE;
}

function axisAlignment(value, primary) {
  const normalized = String(value || "start");
  if (normalized === "center") return "CENTER";
  if (normalized === "end") return "MAX";
  if (normalized === "space-between" && primary) return "SPACE_BETWEEN";
  if (normalized === "baseline" && !primary) return "BASELINE";
  return "MIN";
}

function uniformStrokeWidth(style) {
  const widths = style?.strokeWidths;
  if (!widths || typeof widths !== "object") return null;
  const values = [widths.top, widths.right, widths.bottom, widths.left];
  return values.every((value) => Number.isFinite(value) && value === values[0])
    ? values[0]
    : null;
}

function directChildIds(node) {
  return Array.isArray(node?.children) ? node.children.map((child) => child.id) : [];
}

function nodeFingerprint(node) {
  return JSON.stringify(node, (_key, value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value * 1000) / 1000;
    }
    return value;
  });
}

function collectDefinitionIds(node, ids) {
  if (!node || typeof node !== "object") return;
  if (typeof node.id === "string" && node.id) ids.add(node.id);
  for (const child of node.children || []) collectDefinitionIds(child, ids);
}
