import { EventType, IncrementalSource, NodeType } from '@grafana/rrweb-types';
import type {
  addedNodeMutation,
  eventWithTime,
  serializedElementNodeWithId,
} from '@grafana/rrweb-types';

const now = Date.now();

const element = (
  id: number,
  attributes: Record<string, string> = {},
): serializedElementNodeWithId => ({
  id,
  type: NodeType.Element,
  tagName: 'span',
  attributes,
  childNodes: [],
});

const add = (
  id: number,
  nextId: number,
  elementId: string,
): addedNodeMutation => ({
  parentId: 101,
  nextId,
  node: element(id, { id: elementId }),
});

const createEvents = (
  adds: addedNodeMutation[],
  childNodes: serializedElementNodeWithId[] = [],
): eventWithTime[] => [
  {
    type: EventType.FullSnapshot,
    data: {
      node: {
        id: 1,
        type: NodeType.Document,
        childNodes: [
          {
            id: 2,
            type: NodeType.DocumentType,
            name: 'html',
            publicId: '',
            systemId: '',
          },
          {
            id: 3,
            type: NodeType.Element,
            tagName: 'html',
            attributes: {},
            childNodes: [
              {
                id: 4,
                type: NodeType.Element,
                tagName: 'head',
                attributes: {},
                childNodes: [],
              },
              {
                id: 100,
                type: NodeType.Element,
                tagName: 'body',
                attributes: {},
                childNodes: [
                  {
                    id: 101,
                    type: NodeType.Element,
                    tagName: 'div',
                    attributes: {},
                    childNodes,
                  },
                ],
              },
            ],
          },
        ],
      },
      initialOffset: { top: 0, left: 0 },
    },
    timestamp: now,
  },
  {
    type: EventType.IncrementalSnapshot,
    data: {
      source: IncrementalSource.Mutation,
      adds,
      texts: [],
      removes: [],
      attributes: [],
    },
    timestamp: now + 10,
  },
];

export const missingNextIdEvents = createEvents([add(200, 999, 'a')]);

export const orderedNextIdEvents = createEvents(
  [add(200, 201, 'a'), add(201, 203, 'b')],
  [element(203, { id: 'c' })],
);

export const cyclicNextIdEvents = createEvents([
  add(200, 201, 'a'),
  add(201, 200, 'b'),
]);

export default missingNextIdEvents;
