import { EventType, IncrementalSource } from '@grafana/rrweb-types';
import type { eventWithTime } from '@grafana/rrweb-types';

const now = Date.now();
const events: eventWithTime[] = [
  {
    type: EventType.DomContentLoaded,
    data: {},
    timestamp: now,
  },
  {
    type: EventType.Load,
    data: {},
    timestamp: now + 10,
  },
  {
    type: EventType.Meta,
    data: {
      href: 'http://localhost',
      width: 1000,
      height: 800,
    },
    timestamp: now + 10,
  },
  {
    data: {
      node: {
        id: 1,
        type: 0,
        childNodes: [
          { id: 2, name: 'html', type: 1, publicId: '', systemId: '' },
          {
            id: 3,
            type: 2,
            tagName: 'html',
            attributes: { lang: 'en' },
            childNodes: [
              {
                id: 4,
                type: 2,
                tagName: 'head',
                attributes: {},
                childNodes: [],
              },
              {
                id: 100,
                type: 2,
                tagName: 'body',
                attributes: {},
                childNodes: [
                  {
                    id: 101,
                    type: 2,
                    tagName: 'div',
                    attributes: {},
                    childNodes: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      initialOffset: { top: 0, left: 0 },
    },
    type: EventType.FullSnapshot,
    timestamp: now + 20,
  },
  // Mutation that adds a node with a nextId that does not exist in the mirror.
  // Before the fix this caused an infinite loop because the node was
  // repeatedly re-queued waiting for the missing sibling.
  {
    data: {
      adds: [
        {
          parentId: 101,
          nextId: 999,
          node: {
            type: 2,
            tagName: 'span',
            attributes: {},
            childNodes: [],
            id: 200,
          },
        },
      ],
      texts: [],
      source: IncrementalSource.Mutation,
      removes: [],
      attributes: [],
    },
    type: EventType.IncrementalSnapshot,
    timestamp: now + 30,
  },
];

export default events;
