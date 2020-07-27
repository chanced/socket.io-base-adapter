/**
 * Module dependencies.
 */

import { EventEmitter } from "events";
import {
  Namespace,
  Adapter,
  Rooms,
  Room,
  Packet as EncodedPacket,
  Server,
  Socket,
  Encoder,
} from "socket.io";

export interface SocketPacket {
  type: PacketType;
  nsp: string;
  // not sure which it is? I need to double check.
  id?: number;
  _id?: number;
}
export type PacketOptions = {
  volatile?: boolean;
  compress?: boolean;
  preEncoded?: boolean;
};
declare module "socket.io" {
  interface Socket {
    packet: (packet: EncodedPacket, options: PacketOptions) => void;
  }
  interface Encoder {
    encode: (
      packet: SocketPacket,
      callback: (encodedPackets: EncodedPacket) => void
    ) => void;
  }
  interface Server {
    encoder: Encoder;
  }
}

export enum PacketType {
  Connect = 0,
  Disconnect = 1,
  Event = 2,
  Ack = 3,
  Error = 4,
  BinaryEvent = 5,
  BinaryAck = 6,
}

export type BroadcastFlags = {
  volatile?: boolean;
  compress?: boolean;
};
export type BroadcastOpts = {
  rooms?: string[] | undefined;
  except?: string[] | undefined;
  flags?: BroadcastFlags;
};

export type GetParticipantOpts = {
  rooms?: string[] | IterableIterator<string>;
  room?: string;
  exceptSocketIds?: string[]; // except socket ids
  localOnly?: boolean;
};

type SocketIdsDictionary = { [id: string]: { [room: string]: boolean } };

/**
 * RabbitMQ adapter constructor.
 *
 * @param {Namespace} namespace
 * @api public
 */

export class BaseAdapter extends EventEmitter implements Adapter {
  public nsp: Namespace;
  /**
   * Map<RoomName, SocketIds>
   * Map<string, Set<string>>
   */
  private _rooms: Map<string, Set<string>>;
  private encoder: Encoder;

  constructor(namespace: Namespace) {
    super();
    this.nsp = namespace;
    this.encoder = namespace.server.encoder;

    this._rooms = new Map();
  }
  private async encode(packet: SocketPacket): Promise<EncodedPacket> {
    return new Promise((resolve, reject) => {
      try {
        this.encoder.encode(packet, resolve);
      } catch (err) {
        reject(err);
      }
    });
  }
  get sids() {
    const result: SocketIdsDictionary = {};
    for (const [roomName, participants] of this._rooms.entries()) {
      for (var participant of participants) {
        result[participant] = { ...result[participant], [roomName]: true };
      }
    }
    return result;
  }

  // { [id: string]: { [room: string]: boolean; }; };

  get namespace(): Namespace {
    return this.nsp;
  }
  set namespace(value: Namespace) {
    this.nsp = value;
  }
  get rooms(): Rooms {
    const roomResult: Rooms = {};
    for (const [roomName, participants] of this._rooms.entries()) {
      const sockets: { [socketId: string]: boolean } = {};
      for (const participant of participants) {
        sockets[participant] = true;
      }
      const length = participants.size;
      roomResult[roomName] = { sockets, length };
    }
    return roomResult;
  }

  add(
    socketId: string,
    roomName: string,
    callback?: ((err?: any) => void) | undefined
  ): void {
    if (!roomName || !roomName.length) {
      if (callback && typeof callback === "function") {
        return callback(new Error("Room name cannot be empty"));
      }
      throw new Error("Room name cannot be empty");
    }
    const room = this._rooms.get(roomName) || new Set<string>();
    room.add(socketId);
    if (!this._rooms.has(roomName)) {
      this._rooms.set(roomName, room);
    }
    return callback ? callback(null) : undefined;
  }
  addAll(
    socketId: string,
    rooms: string[],
    callback: ((err?: any) => void) | undefined
  ) {
    try {
      for (const room of rooms) {
        this.add(socketId, room);
      }
    } catch (err) {
      if (callback && typeof callback === "function") {
        return callback(err);
      }
      throw err;
    }
    return callback ? callback(null) : undefined;
  }

  /**
   * Removes a socket from a room.
   * @api public
   */
  del(
    socketId: string,
    roomName: string,
    callback?: ((err?: any) => void) | undefined
  ): void {
    this.emit("delete", { socketId, room: roomName });
    this.emit("del", { socketId, room: roomName });
    const room = this._rooms.get(roomName);
    if (!room) {
      return !!callback ? callback(new Error("Room not found")) : undefined;
    }
    const applicable = room.has(socketId);
    room.delete(socketId);
  }
  /**
   * Removes a socket from all rooms it is in.
   */

  delAll(socketId: string): void {
    this.emit("delAll", { socketId });
    this.emit("deleteAll", { socketId });
    for (var [name, socketIds] of this._rooms.entries()) {
      if (socketIds.has(name)) {
        this.del(socketId, name);
      }
    }
  }

  private *getSockets(
    params: GetParticipantOpts
  ): Generator<Socket, Set<Socket>> {
    const connectedSockets = this.namespace.connected;
    const sockets = new Set<Socket>();
    for (var socketId of this.getParticipants({ ...params, localOnly: true })) {
      const socket = connectedSockets[socketId];
      if (socket && !sockets.has(socket)) {
        yield socket;
        sockets.add(socket);
      }
    }
    return sockets;
  }
  private *getParticipants(
    params: GetParticipantOpts
  ): Generator<string, Set<string>> {
    let {
      rooms: roomNames,
      room: roomName,
      exceptSocketIds,
      localOnly,
    } = params;
    const connectedSockets = this.namespace.connected;
    if (typeof roomNames === "string") {
      roomNames = [roomNames];
    }
    if (roomNames == null) {
      roomNames = this._rooms.keys();
    }
    const participants = new Set<string>();
    for (var name of roomNames) {
      const room = this._rooms.get(name);
      if (!room) {
        continue;
      }
      for (var socketId of room) {
        if (!participants.has(socketId)) {
          if (
            (exceptSocketIds &&
              exceptSocketIds.length &&
              exceptSocketIds.includes(socketId)) ||
            (localOnly && !connectedSockets.hasOwnProperty(socketId))
          ) {
            continue;
          }
          yield socketId;
          participants.add(socketId);
        }
      }
    }
    return participants;
  }

  /**
   * Broadcasts a packet.
   */
  async broadcast(
    packet: SocketPacket,
    opts: BroadcastOpts = {}
  ): Promise<void> {
    const { rooms, except: exceptSocketIds, flags } = opts;
    const packetOpts = { preEncoded: true, ...flags };
    const namespacedPacket = { ...packet, nsp: this.namespace.name }; // this.namespace is equiv to this.nsp
    this.emit("broadcast", {
      packet: packet,
      namespace: this.namespace,
      options: {
        rooms: rooms,
        except: exceptSocketIds,
        flags: packetOpts,
      },
    });
    const encodedPacket = await this.encode(namespacedPacket);
    const sentToSocketIds: string[] = [];
    let sent = 0;
    for (const socket of this.getSockets({
      exceptSocketIds,
      rooms,
      localOnly: true,
    })) {
      this.emit("packet/sending", {
        namespace: this.namespace,
        socket,
        packet,
        encodedPacket,
        options: packetOpts,
      });
      socket.packet(encodedPacket, packetOpts);
      sentToSocketIds.push(socket.id);
      this.emit("packet/sent", {
        namespace: this.namespace,
        socket,
        packet,
        encodedPacket,
        options: packetOpts,
      });
      sent = sent + 1;
    }
    this.emit("broadcast/complete", {
      totalSent: sent,
      sentTo: sentToSocketIds,
      namespace: this.namespace,
      packet,
      encodedPacket,
    });
  }
}

export class RabbitSocketIOAdapter extends BaseAdapter {
  constructor(namespace: Namespace) {
    super(namespace);
  }
}

export default BaseAdapter;
