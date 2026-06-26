/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createMirror,
  IGNORED_NODE,
  type serializedNodeWithId,
} from '@grafana/rrweb-snapshot';
import type { addedNodeMutation, mutationData } from '@grafana/rrweb-types';
import MutationBuffer from '../../src/record/mutation';
import type { MutationBufferParam } from '../../src/types';
import ProcessedNodeManager from '../../src/record/processed-node-manager';

function stubManagers() {
  return {
    iframeManager: {
      addIframe: vi.fn(),
      attachIframe: vi.fn(),
    },
    stylesheetManager: {
      trackLinkElement: vi.fn(),
      attachLinkElement: vi.fn(),
    },
    shadowDomManager: {
      addShadowRoot: vi.fn(),
      observeAttachShadow: vi.fn(),
      reset: vi.fn(),
    },
    canvasManager: {
      freeze: vi.fn(),
      unfreeze: vi.fn(),
      lock: vi.fn(),
      unlock: vi.fn(),
      reset: vi.fn(),
    },
    processedNodeManager: new ProcessedNodeManager(),
  };
}

function makeSn(id: number, tagName: string): serializedNodeWithId {
  return {
    type: 2,
    tagName,
    attributes: {},
    childNodes: [],
    id,
  } as unknown as serializedNodeWithId;
}

function setupBuffer() {
  const mirror = createMirror();
  const managers = stubManagers();
  const mutationCb = vi.fn();

  const buf = new MutationBuffer();
  buf.init({
    mutationCb,
    blockClass: 'rr-block',
    blockSelector: null,
    maskTextClass: 'rr-mask',
    maskTextSelector: null,
    inlineStylesheet: true,
    maskInputOptions: {},
    maskTextFn: undefined,
    maskInputFn: undefined,
    keepIframeSrcFn: () => false,
    recordCanvas: false,
    inlineImages: false,
    slimDOMOptions: {},
    dataURLOptions: {},
    doc: document,
    mirror,
    ...managers,
  } as unknown as MutationBufferParam);

  return { buf, mirror, mutationCb, managers };
}

function getAdds(mutationCb: ReturnType<typeof vi.fn>): addedNodeMutation[] {
  expect(mutationCb).toHaveBeenCalled();
  const payload = mutationCb.mock.calls[0][0] as mutationData;
  return (payload as { adds: addedNodeMutation[] }).adds;
}

describe('ancestor gap resolution', () => {
  it('resolves a single-level gap ancestor', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    // Mirror: document -> html -> body (ids 1,2,3)
    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // DOM: body > gapDiv > childSpan
    const gapDiv = document.createElement('div');
    const childSpan = document.createElement('span');
    gapDiv.appendChild(childSpan);
    document.body.appendChild(gapDiv);

    // gapDiv is NOT in the mirror — it's a gap node
    // childSpan is observed as added
    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(childSpan);
    buf.emit();

    const adds = getAdds(mutationCb);
    expect(adds.length).toBe(2);
    // Gap div should be first (parent before child)
    expect(adds[0].parentId).toBe(3); // body
    expect(adds[1].parentId).toBe(adds[0].node.id); // child under gap div
    // gapDiv should now be in the mirror
    expect(mirror.getId(gapDiv)).not.toBe(-1);

    document.body.removeChild(gapDiv);
  });

  it('resolves a multi-level gap chain in top-down order', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > A(gap) > B(gap) > child
    const a = document.createElement('div');
    const b = document.createElement('div');
    const child = document.createElement('span');
    b.appendChild(child);
    a.appendChild(b);
    document.body.appendChild(a);

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(child);
    buf.emit();

    const adds = getAdds(mutationCb);
    expect(adds.length).toBe(3);
    // Order: A, B, child
    expect(adds[0].parentId).toBe(3); // A under body
    expect(adds[1].parentId).toBe(adds[0].node.id); // B under A
    expect(adds[2].parentId).toBe(adds[1].node.id); // child under B

    document.body.removeChild(a);
  });

  it('does not double-serialize a node in addedSet', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > parent(gap, also in addedSet) > child
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);

    const addedSet = (buf as unknown as { addedSet: Set<Node> }).addedSet;
    addedSet.add(parent);
    addedSet.add(child);

    buf.emit();

    const adds = getAdds(mutationCb);
    // Both parent and child should appear, but parent only ONCE
    const parentAdds = adds.filter((a) => a.node.id === mirror.getId(parent));
    expect(parentAdds.length).toBe(1);
    expect(adds.length).toBe(2);

    document.body.removeChild(parent);
  });

  it('aborts resolution when ancestor is blocked', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    const blocked = document.createElement('div');
    blocked.className = 'rr-block';
    const child = document.createElement('span');
    blocked.appendChild(child);
    document.body.appendChild(blocked);

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(child);
    buf.emit();

    // Neither blocked parent nor child should be emitted via gap resolution
    // (child may be emitted as a placeholder by normal pushAdd if blocked
    // parents produce placeholder nodes, but not via gap resolution)
    expect(mutationCb).not.toHaveBeenCalled();

    document.body.removeChild(blocked);
  });

  it('aborts resolution when ancestor has IGNORED_NODE id', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > ignored(gap) > child
    const ignored = document.createElement('div');
    const child = document.createElement('span');
    ignored.appendChild(child);
    document.body.appendChild(ignored);

    // Pre-seed the ignored node as IGNORED_NODE in the mirror
    mirror.add(ignored, makeSn(IGNORED_NODE, 'div'));

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(child);
    buf.emit();

    // Gap resolution should fail because parent has IGNORED_NODE id.
    // The child may still be emitted by normal pushAdd (with parentId=-2),
    // but no gap ancestor should be serialized.
    if (mutationCb.mock.calls.length > 0) {
      const adds = getAdds(mutationCb);
      // No gap-resolved add for the ignored parent
      const ignoredAdds = adds.filter((a) => a.node.id !== IGNORED_NODE && a.parentId !== -2);
      expect(ignoredAdds.length).toBe(0);
    }

    document.body.removeChild(ignored);
  });

  it('enforces MAX_GAP_DEPTH limit', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // Build a chain of 22 gap nodes (exceeds MAX_GAP_DEPTH=20)
    let current: Element = document.body;
    const nodes: Element[] = [];
    for (let i = 0; i < 22; i++) {
      const div = document.createElement('div');
      current.appendChild(div);
      nodes.push(div);
      current = div;
    }
    const leaf = document.createElement('span');
    current.appendChild(leaf);

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(leaf);
    buf.emit();

    // The chain is too deep — gap resolution should fail and leaf should
    // be dropped (no mutation emitted, or emitted without the leaf)
    expect(mutationCb).not.toHaveBeenCalled();

    // Clean up
    document.body.removeChild(nodes[0]);
  });

  it('succeeds at exactly MAX_GAP_DEPTH', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // Build exactly 19 gap nodes — resolveAncestorGap recurses with
    // depth 0..18 for 19 ancestors, all below MAX_GAP_DEPTH=20
    let current: Element = document.body;
    const nodes: Element[] = [];
    for (let i = 0; i < 19; i++) {
      const div = document.createElement('div');
      current.appendChild(div);
      nodes.push(div);
      current = div;
    }
    const leaf = document.createElement('span');
    current.appendChild(leaf);

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(leaf);
    buf.emit();

    const adds = getAdds(mutationCb);
    // 19 gap ancestors + 1 leaf = 20 adds
    expect(adds.length).toBe(20);
    // First add's parent should be body
    expect(adds[0].parentId).toBe(3);

    document.body.removeChild(nodes[0]);
  });

  it('serializes two siblings under the same gap parent only once', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > gapDiv > [child1, child2]
    const gapDiv = document.createElement('div');
    const child1 = document.createElement('span');
    const child2 = document.createElement('span');
    gapDiv.appendChild(child1);
    gapDiv.appendChild(child2);
    document.body.appendChild(gapDiv);

    const addedSet = (buf as unknown as { addedSet: Set<Node> }).addedSet;
    addedSet.add(child1);
    addedSet.add(child2);

    buf.emit();

    const adds = getAdds(mutationCb);
    // gapDiv serialized once + 2 children = 3 adds
    expect(adds.length).toBe(3);
    // gapDiv should appear exactly once
    const gapDivId = mirror.getId(gapDiv);
    const gapAdds = adds.filter((a) => a.node.id === gapDivId);
    expect(gapAdds.length).toBe(1);
    // Both children should have gapDiv as parent
    expect(adds[1].parentId).toBe(gapDivId);
    expect(adds[2].parentId).toBe(gapDivId);

    document.body.removeChild(gapDiv);
  });

  it('bails at shadow root boundary', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > host (mirrored, with shadow root) > gap > child
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    mirror.add(host, makeSn(4, 'div'));

    const gap = document.createElement('div');
    const child = document.createElement('span');
    gap.appendChild(child);
    shadow.appendChild(gap);

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(child);
    buf.emit();

    // Gap resolution should bail at the shadow root boundary.
    // The child should not be emitted because its gap parent cannot be resolved.
    expect(mutationCb).not.toHaveBeenCalled();

    document.body.removeChild(host);
  });

  it('does not serialize a node in movedSet as a gap', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > parent(gap, in movedSet) > child
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);

    // parent is in movedSet (it was seen before, re-attached)
    mirror.add(parent, makeSn(10, 'div'));
    const movedSet = (buf as unknown as { movedSet: Set<Node> }).movedSet;
    movedSet.add(parent);

    (buf as unknown as { addedSet: Set<Node> }).addedSet.add(child);
    buf.emit();

    const adds = getAdds(mutationCb);
    // parent should appear via its own movedSet processing, not via gap resolution
    // child should also appear
    const parentAdds = adds.filter((a) => a.node.id === 10);
    expect(parentAdds.length).toBe(1);

    document.body.removeChild(parent);
  });

  it('resolves gap via addList retry when nextId was initially -1', () => {
    const { buf, mirror, mutationCb } = setupBuffer();

    mirror.add(document, makeSn(1, '#document'));
    mirror.add(document.documentElement, makeSn(2, 'html'));
    mirror.add(document.body, makeSn(3, 'body'));

    // body > gapDiv > [child, unmirrored_sibling]
    // child's nextSibling is unmirrored, so nextId = -1 initially → goes to addList
    const gapDiv = document.createElement('div');
    const child = document.createElement('span');
    const sibling = document.createElement('span');
    gapDiv.appendChild(child);
    gapDiv.appendChild(sibling);
    document.body.appendChild(gapDiv);

    const addedSet = (buf as unknown as { addedSet: Set<Node> }).addedSet;
    addedSet.add(child);
    addedSet.add(sibling);

    buf.emit();

    const adds = getAdds(mutationCb);
    // gapDiv should be resolved, both children emitted
    expect(adds.length).toBe(3);
    expect(adds[0].parentId).toBe(3); // gapDiv under body

    document.body.removeChild(gapDiv);
  });
});
