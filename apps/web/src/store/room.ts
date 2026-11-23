import { create } from 'zustand';
import {
  CHAT_HISTORY_MAX,
  type ChatMessage,
  type ErrorCode,
  type Participant,
  type PlaybackState,
  type QueueItem,
  type Reaction,
  type RoomBufferEvent,
  type RoomJoinResult,
} from '@watchparty/shared-types';

export type Connection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type GateMode = 'open' | 'vad' | 'ptt';

interface Session {
  roomCode: string;
  userId: string;
  nickname: string;
}

export interface RemoteMedia {
  cam: MediaStream | null;
  screen: MediaStream | null;
}

interface CallState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  /** Mic gate open right now (VAD / PTT / open). */
  talking: boolean;
  gateMode: GateMode;
  vadThresholdDb: number;
  localCam: MediaStream | null;
  localScreen: MediaStream | null;
  remote: Record<string, RemoteMedia>;
  speaking: Record<string, boolean>;
  /** Sharer captured no audio track (Mode C). */
  screenNoAudio: boolean;
}

const REACTION_TTL_MS = 4_000;

interface Data {
  connection: Connection;
  session: Session | null;
  /** The web tab gave its seat to the extension (Mode B); no auto-rejoin until "Rejoin here". */
  handedOff: boolean;
  hostId: string | null;
  state: PlaybackState | null;
  participants: Participant[];
  chat: ChatMessage[];
  queue: QueueItem[];
  reactions: Reaction[];
  buffer: RoomBufferEvent;
  hostOnlyControl: boolean;
  lastError: { code: ErrorCode; message: string } | null;
  autoplayBlocked: boolean;
  /** The file this viewer picked for a `local:<name>` room (never leaves the browser). */
  localFile: File | null;
  call: CallState;
}

interface Actions {
  applyJoin(r: RoomJoinResult, nickname: string): void;
  setState(s: PlaybackState): void;
  setParticipants(participants: Participant[], hostId: string): void;
  addChat(m: ChatMessage): void;
  addReaction(r: Reaction): void;
  patchCall(p: Partial<CallState>): void;
  leaveSession(): void;
}

const initial = (): Data => ({
  connection: 'idle',
  session: null,
  handedOff: false,
  hostId: null,
  state: null,
  participants: [],
  chat: [],
  queue: [],
  reactions: [],
  buffer: { waiting: false, userIds: [] },
  hostOnlyControl: false,
  lastError: null,
  autoplayBlocked: false,
  localFile: null,
  call: {
    mic: false,
    cam: false,
    screen: false,
    talking: false,
    gateMode: 'vad',
    vadThresholdDb: -45,
    localCam: null,
    localScreen: null,
    remote: {},
    speaking: {},
    screenNoAudio: false,
  },
});

export const useRoom = create<Data & Actions>()((set, get) => ({
  ...initial(),
  applyJoin: (r, nickname) => {
    const cur = get();
    // A newer room:state for this room can beat the ack (Redis fan-out); otherwise the ack wins, whatever its seq (§7).
    // No session yet = first join: room:state is only accepted while that join is in flight (lib/socket.ts).
    const sameRoom = (cur.session?.roomCode ?? r.roomCode) === r.roomCode;
    set({
      session: { roomCode: r.roomCode, userId: r.userId, nickname },
      handedOff: false,
      hostId: r.hostId,
      state: sameRoom && cur.state && cur.state.seq > r.state.seq ? cur.state : r.state,
      participants: r.participants,
      chat: r.chat.slice(-CHAT_HISTORY_MAX),
      queue: r.queue,
      buffer: { waiting: false, userIds: [] },
      lastError: null,
      call: { ...cur.call, remote: {}, speaking: {} },
    });
  },
  setState: (s) => {
    const cur = get().state;
    if (cur && s.seq <= cur.seq) return;
    set({ state: s });
  },
  setParticipants: (participants, hostId) => set({ participants, hostId }),
  addChat: (m) => set({ chat: [...get().chat, m].slice(-CHAT_HISTORY_MAX) }),
  addReaction: (r) => {
    set({ reactions: [...get().reactions, r] });
    setTimeout(() => set({ reactions: get().reactions.filter((x) => x.id !== r.id) }), REACTION_TTL_MS);
  },
  patchCall: (p) => set({ call: { ...get().call, ...p } }),
  leaveSession: () => set({ ...initial(), connection: get().connection }),
}));

/** Can the given user drive playback (SYNC_PROTOCOL §4.3: host only when hostOnlyControl). */
export function canControl(s: Pick<Data, 'session' | 'hostId' | 'hostOnlyControl'>): boolean {
  return !!s.session && (!s.hostOnlyControl || s.hostId === s.session.userId);
}
