// Builds the ELK graph for one trace step. See elk-task/elk-plan.md 6.1.
//
// Structure only: no sizes, no DOM. measure.ts fills width/height and port
// positions, then elk.layout() assigns coordinates.
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api";
import type { Address, BackendTraceElem, HeapValue, Value } from "./types";
import { asRecord, outgoingRefs, visibleAddresses } from "./reachability";

export type NodeKind =
  | "frame"
  | "current-frame"
  | "list"
  | "tuple"
  | "set"
  | "dict"
  | "instance";

/** One `key | value` line inside a node. `ref` is set when the line holds a reference. */
export type RowModel = {
  key: string;
  value: string;
  ref?: Address;
  /**
   * Set when the *key* is itself a reference, which only dicts can produce
   * (`{(1, 2): "pair"}`). Such a key needs its own arrow, or the key object shows up
   * with nothing pointing at it and ELK lays it out as a root, left of the frames.
   */
  keyRef?: Address;
  /** `return` rows are highlighted, as they are today. */
  isReturn?: boolean;
};

export type NodeModel = {
  id: string;
  kind: NodeKind;
  header: string;
  rows: RowModel[];
  /** Heap address, absent for frames. Only object nodes can be collapsed. */
  address?: Address;
  collapsed: boolean;
  /** Shown instead of the rows while collapsed, e.g. "12 elements". */
  summary: string;
};

export type VizGraph = {
  /** Handed to elk.layout(). Node content is *not* in here — ELK may drop unknown fields. */
  graph: ElkNode;
  /** Node id -> content, for measure.ts and graph-renderer.ts. */
  nodes: Map<string, NodeModel>;
};

/**
 * Layout options settled by the spike, whose findings are in elk-task/elk-plan.md 7.1:
 * - cycleBreaking stays at its GREEDY default, or the frames' layer constraint throws
 *   as soon as an edge is reversed into a frame (plan 4).
 * - considerModelOrder is deliberately absent: it buys no stability and costs 2.5x
 *   (plan 6.5). Stability comes from emitting nodes in a deterministic order.
 */
export const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "25",
  "elk.layered.spacing.nodeNodeBetweenLayers": "60",
};

export const frameNodeId = (index: number): string => `frame:${index}`;
export const objectNodeId = (address: Address): string => `obj:${address}`;
export const rowPortId = (nodeId: string, rowIndex: number): string =>
  `${nodeId}:${rowIndex}`;
/** Second port on a dict row whose key is a reference. */
export const keyPortId = (nodeId: string, rowIndex: number): string =>
  `${nodeId}:${rowIndex}k`;
export const inputPortId = (nodeId: string): string => `${nodeId}:in`;

/** Primitive rendering, matching html-generator.getCorrectValueOf. */
export function formatValue(value: Value): string {
  switch (value.type) {
    case "ref":
      return "";
    case "none":
      return "None";
    default:
      return String(value.value);
  }
}

function dictKeyLabel(key: Value | undefined): string {
  if (!key) {
    return "";
  }
  // A reference key has no text of its own; the arrow leaving the key cell says
  // what it is. The bracket keeps the cell from looking empty.
  return key.type === "ref" ? "[key]" : formatValue(key);
}

function headerOf(heapValue: HeapValue): string {
  return heapValue.type === "instance" ? heapValue.name : heapValue.type;
}

function summaryOf(heapValue: HeapValue, rowCount: number): string {
  switch (heapValue.type) {
    case "dict":
      return `${rowCount} ${rowCount === 1 ? "entry" : "entries"}`;
    case "instance":
      return `${rowCount} ${rowCount === 1 ? "field" : "fields"}`;
    default:
      return `${rowCount} ${rowCount === 1 ? "element" : "elements"}`;
  }
}

/**
 * Rows of a heap object. list/tuple/set render vertically like dict and instance
 * (plan 5.2), with the index playing the role of the key.
 */
export function rowsOfHeapValue(heapValue: HeapValue): RowModel[] {
  switch (heapValue.type) {
    case "dict": {
      const keys = asRecord<Value>(heapValue.keys);
      const values = asRecord<Value>(heapValue.value);
      return Object.keys(values).map((slot) => {
        const value = values[slot];
        const key = keys[slot];
        return {
          key: dictKeyLabel(key),
          value: formatValue(value),
          ref: value.type === "ref" ? value.value : undefined,
          keyRef: key?.type === "ref" ? key.value : undefined,
        };
      });
    }
    case "instance": {
      const fields = asRecord<Value>(heapValue.value);
      return Object.keys(fields).map((name) => {
        const value = fields[name];
        return {
          key: name,
          value: formatValue(value),
          ref: value.type === "ref" ? value.value : undefined,
        };
      });
    }
    case "set":
      // A set has no index, so the key column stays empty.
      return heapValue.value.map((value) => ({
        key: "",
        value: formatValue(value),
        ref: value.type === "ref" ? value.value : undefined,
      }));
    default:
      return heapValue.value.map((value, index) => ({
        key: `[${index}]`,
        value: formatValue(value),
        ref: value.type === "ref" ? value.value : undefined,
      }));
  }
}

function elkNodeFor(model: NodeModel, extraOptions?: Record<string, string>): ElkNode {
  const ports: ElkPort[] = [];

  // Objects get one west input port so arrowheads always land in the same place
  // (plan 6.1). Frames are never targets, so they do not get one.
  if (model.address !== undefined) {
    ports.push({
      id: inputPortId(model.id),
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": "WEST" },
    });
  }

  if (!model.collapsed) {
    model.rows.forEach((row, index) => {
      if (row.keyRef !== undefined) {
        ports.push({
          id: keyPortId(model.id, index),
          width: 0,
          height: 0,
          layoutOptions: { "elk.port.side": "EAST" },
        });
      }
      if (row.ref === undefined) {
        return;
      }
      ports.push({
        id: rowPortId(model.id, index),
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": "EAST" },
      });
    });
  }

  return {
    id: model.id,
    // Filled in by measure.ts; ELK requires them to exist.
    width: 0,
    height: 0,
    ports,
    layoutOptions: {
      "elk.portConstraints": "FIXED_POS",
      ...extraOptions,
    },
  };
}

export function buildGraph(
  elem: BackendTraceElem,
  collapsed: ReadonlySet<Address> = new Set()
): VizGraph {
  const heap = asRecord<HeapValue>(elem.heap);
  const visible = visibleAddresses(elem, collapsed);
  const models = new Map<string, NodeModel>();
  const children: ElkNode[] = [];
  const edges: ElkExtendedEdge[] = [];

  const addEdge = (sourcePort: string, target: Address) => {
    edges.push({
      id: `edge:${sourcePort}->${target}`,
      sources: [sourcePort],
      targets: [inputPortId(objectNodeId(target))],
    });
  };

  // Frames, in stack order. The *last* entry is the currently executing frame;
  // html-generator marked index 0 instead, which was the <module> frame (plan 2).
  const lastFrameIndex = elem.stack.length - 1;
  elem.stack.forEach((frame, index) => {
    const id = frameNodeId(index);
    const model: NodeModel = {
      id,
      kind: index === lastFrameIndex ? "current-frame" : "frame",
      header: frame.frameName === "<module>" ? "Global" : frame.frameName,
      rows: frame.locals.map((local) => ({
        key: local.name,
        value: formatValue(local),
        ref: local.type === "ref" ? local.value : undefined,
        isReturn: local.name === "return",
      })),
      collapsed: false,
      summary: "",
    };
    models.set(id, model);
    children.push(
      // FIRST_SEPARATE, not FIRST: frames get a layer of their own, which is what the
      // Frames/Objects bands assume, and it measurably halves layout time (plan 7.7).
      elkNodeFor(model, {
        "elk.layered.layering.layerConstraint": "FIRST_SEPARATE",
      })
    );
    model.rows.forEach((row, rowIndex) => {
      if (row.ref !== undefined && visible.has(row.ref)) {
        addEdge(rowPortId(id, rowIndex), row.ref);
      }
    });
  });

  // Objects, ascending address, so the order is identical across steps (plan 6.5).
  const addresses = [...visible].sort((a, b) => a - b);
  for (const address of addresses) {
    const heapValue = heap[address];
    if (!heapValue) {
      continue;
    }
    const id = objectNodeId(address);
    const rows = rowsOfHeapValue(heapValue);
    const isCollapsed = collapsed.has(address);
    const model: NodeModel = {
      id,
      kind: heapValue.type,
      header: headerOf(heapValue),
      rows,
      address,
      collapsed: isCollapsed,
      summary: summaryOf(heapValue, rows.length),
    };
    models.set(id, model);
    children.push(elkNodeFor(model));

    if (isCollapsed) {
      continue;
    }
    rows.forEach((row, rowIndex) => {
      if (row.keyRef !== undefined && visible.has(row.keyRef)) {
        addEdge(keyPortId(id, rowIndex), row.keyRef);
      }
      if (row.ref !== undefined && visible.has(row.ref)) {
        addEdge(rowPortId(id, rowIndex), row.ref);
      }
    });
  }

  return {
    graph: { id: "root", layoutOptions: LAYOUT_OPTIONS, children, edges },
    nodes: models,
  };
}

/** Addresses a heap object points at. Re-exported so callers need one import. */
export { outgoingRefs };
