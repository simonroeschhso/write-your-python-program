// Ties the pipeline together: model -> measure -> ELK -> DOM.
// See elk-task/elk-plan.md 6.
import ELK from "elkjs/lib/elk.bundled.js";
import type { Address, BackendTraceElem } from "../types";
import { buildGraph } from "../graph-model";
import { ensureFontsReady, measureGraph } from "./measure";
import { renderGraph, type RenderOptions } from "./graph-renderer";

// No workerUrl: elkjs then uses its in-process fake worker. A real Web Worker
// would be blocked anyway, the webview CSP has no worker-src (plan 2).
let elk: InstanceType<typeof ELK> | null = null;

function elkInstance(): InstanceType<typeof ELK> {
  if (!elk) {
    elk = new ELK();
  }
  return elk;
}

// Layout is async, and steps can be requested faster than they finish. Only the
// most recent request is allowed to touch the DOM.
let renderToken = 0;

/**
 * The first layout pays ~330 ms of JIT warm-up (spike, plan 6.5). Doing it on a
 * throwaway graph at start-up keeps that cost out of the first real step.
 */
export async function prewarm(): Promise<void> {
  await ensureFontsReady();
  try {
    await elkInstance().layout({
      id: "prewarm",
      children: [
        { id: "a", width: 10, height: 10 },
        { id: "b", width: 10, height: 10 },
      ],
      edges: [{ id: "e", sources: ["a"], targets: ["b"] }],
    });
  } catch {
    // Warm-up only; a failure here says nothing about real layouts.
  }
}

export async function renderStep(
  container: HTMLElement,
  elem: BackendTraceElem,
  collapsed: ReadonlySet<Address>,
  options: RenderOptions = {}
): Promise<void> {
  const token = ++renderToken;
  const viz = buildGraph(elem, collapsed);
  const elements = measureGraph(viz);
  const laidOut = await elkInstance().layout(viz.graph);
  if (token !== renderToken) {
    return;
  }
  renderGraph(container, laidOut, viz.nodes, elements, options);
}
