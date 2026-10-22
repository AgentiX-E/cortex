/**
 * The worker wiring, in one place, for tests that need a real channel.
 *
 * Two suites need it: the protocol suite (which asserts what crosses the boundary) and the parity
 * suite (which asserts that crossing it changes nothing). Writing the wiring twice would let them
 * differ -- one starting the port and one not, one closing both ends and one leaving a handle --
 * and the difference would look like a protocol bug in whichever suite ran second.
 */
import { MessageChannel } from 'node:worker_threads';
import {
  EngineRpcSession,
  createEngineRpcHandler,
  type MessageEndpoint,
  type RpcReply,
  type SqlEngine,
} from '../../browser/rpc.js';

export type ChannelSession = {
  session: EngineRpcSession;
  /** Close the session and both ports. Safe to call twice. */
  close: () => Promise<void>;
};

export function openChannelSession(engine: SqlEngine): ChannelSession {
  const { port1, port2 } = new MessageChannel();
  const handler = createEngineRpcHandler(engine, (reply: RpcReply) => port1.postMessage(reply));
  // Node types `MessagePort.addEventListener` with the DOM `Event`, while the session's structural
  // interface declares `{ data }` -- the browser shape it also has to satisfy. The cast names that
  // mismatch instead of spreading `any` through the suite.
  const workerSide = port1 as unknown as {
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    start(): void;
  };
  workerSide.addEventListener('message', (event) => handler(event.data));
  workerSide.start();

  // Cast, not a stub: Node's `MessagePort` implements the three methods the session uses, but its
  // `addEventListener` types the listener parameter as `MessageEvent` rather than as the structural
  // `{ data }` the browser-compatible interface declares.
  const session = new EngineRpcSession(port2 as unknown as MessageEndpoint);

  return {
    session,
    close: async () => {
      await session.close();
      port1.close();
      port2.close();
    },
  };
}
