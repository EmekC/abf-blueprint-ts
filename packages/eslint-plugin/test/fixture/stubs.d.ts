declare function event(...args: unknown[]): any;
declare function override(...args: unknown[]): any;

declare class StubActor {
  /** @bpReplicated */
  Score: number;
  /** @bpReplicated */
  Names: string[];
  /** Not replicated. */
  Local: number;
  /** Not replicated. */
  Log: string[];
  /** @bpRpc multicast @bpReliable */
  Boom(): void;
  /**
   * @bpRpc client
   */
  Notify(): void;
  /** @bpRpc server */
  Ask(): void;
  /** @bpRpc server */
  ServerDo(): void;
  Plain(): void;
  HasAuthority(): boolean;
  IsServer(): boolean;
}
