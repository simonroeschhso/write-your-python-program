// Offscreen measurement. See elk-task/elk-plan.md 6.2.
//
// ELK needs a width and a height for every node before it can lay anything out, and our
// nodes are HTML, so the browser has to be asked. The elements built here are throwaway;
// graph-renderer.ts builds its own from the same `renderNode`, which is what keeps the
// measured size and the drawn size in agreement.
import type { ElkNode } from "elkjs/lib/elk-api";
import type { VizGraph } from "../graph-model";
import { inputPortId, rowPortId } from "../graph-model";
import { renderNode, headerElement, rowElements } from "./node-view";

const HOST_ID = "elk-measure-host";

/** Wide enough that nothing wraps for want of room; nodes size to their content. */
const HOST_WIDTH_PX = 4000;

function measureHost(): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.textContent = "";
    return existing;
  }
  const host = document.createElement("div");
  host.id = HOST_ID;
  // visibility: hidden, never display: none -- a display:none subtree has no
  // layout boxes at all and every measurement comes back zero.
  host.style.cssText = [
    "position: absolute",
    "visibility: hidden",
    "pointer-events: none",
    "left: -20000px",
    "top: 0",
    `width: ${HOST_WIDTH_PX}px`,
  ].join("; ");
  document.body.append(host);
  return host;
}

/**
 * Web fonts change text metrics, so anything measured before they load is wrong.
 * Await this once before the first layout.
 */
export function ensureFontsReady(): Promise<void> {
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
  return fonts ? fonts.ready.then(() => undefined) : Promise.resolve();
}

/**
 * Fills width/height on every node of `viz.graph` and positions its ports.
 */
export function measureGraph(viz: VizGraph): void {
  const host = measureHost();
  const elements = new Map<string, HTMLElement>();
  const children: ElkNode[] = viz.graph.children ?? [];

  // Write phase: build the whole subtree first, so the reads below trigger a
  // single layout pass instead of one per node.
  for (const child of children) {
    const model = viz.nodes.get(child.id);
    if (!model) {
      continue;
    }
    const element = renderNode(model);
    elements.set(child.id, element);
    host.append(element);
  }

  // Read phase.
  for (const child of children) {
    const element = elements.get(child.id);
    if (!element) {
      continue;
    }
    const nodeBox = element.getBoundingClientRect();
    const width = Math.ceil(nodeBox.width);
    const height = Math.ceil(nodeBox.height);
    child.width = width;
    child.height = height;

    const model = viz.nodes.get(child.id);
    const rowCenters = rowElements(element).map((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2 - nodeBox.top;
    });
    const header = headerElement(element);
    const headerBox = header?.getBoundingClientRect();
    const headerCenter = headerBox
      ? headerBox.top + headerBox.height / 2 - nodeBox.top
      : height / 2;

    for (const port of child.ports ?? []) {
      if (port.id === inputPortId(child.id)) {
        // West side, level with the header, so the arrowhead points at the title.
        port.x = 0;
        port.y = Math.round(headerCenter);
        continue;
      }
      const rowIndex = (model?.rows ?? []).findIndex(
        (_, index) => rowPortId(child.id, index) === port.id
      );
      port.x = width;
      port.y =
        rowIndex >= 0 && rowCenters[rowIndex] !== undefined
          ? Math.round(rowCenters[rowIndex])
          : Math.round(height / 2);
    }
  }

  host.textContent = "";
}
