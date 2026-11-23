// Room UI state local to the content script. Written by content/index.tsx (socket owner), read by the sidebar.
import { create } from 'zustand';
import type { ChatMessage, Participant, QueueItem, Reaction } from '@watchparty/shared-types';
import type { SyncStatus } from '@watchparty/sync-engine';

export type Phase = 'idle' | 'prompt' | 'connecting' | 'joined' | 'reconnecting' | 'error';
export type VideoPhase = 'searching' | 'syncing' | 'missing';

export type Notice =
  | { kind: 'navigated'; partyUrl: string; canLoad: boolean }
  | { kind: 'switched'; url: string }
  | { kind: 'iframe'; src: string }
  | { kind: 'manualSeek'; position: number };

export interface RoomView {
  phase: Phase;
  error: string | null;
  roomCode: string | null;
  promptCode: string;
  nickname: string;
  userId: string | null;
  hostId: string | null;
  hostOnlyControl: boolean;
  participants: Participant[];
  chat: ChatMessage[];
  queue: QueueItem[];
  reactions: Reaction[];
  buffer: { waiting: boolean; userIds: string[] };
  sync: SyncStatus | null;
  video: VideoPhase;
  notice: Notice | null;
  autoplayBlocked: boolean;
  toast: string | null;
  collapsed: boolean;
  unread: number;
}

export const initialView: RoomView = {
  phase: 'idle',
  error: null,
  roomCode: null,
  promptCode: '',
  nickname: '',
  userId: null,
  hostId: null,
  hostOnlyControl: false,
  participants: [],
  chat: [],
  queue: [],
  reactions: [],
  buffer: { waiting: false, userIds: [] },
  sync: null,
  video: 'searching',
  notice: null,
  autoplayBlocked: false,
  toast: null,
  collapsed: false,
  unread: 0,
};

export const useRoom = create<RoomView>()(() => initialView);
