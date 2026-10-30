export class TargetInputInterceptState {
  private readonly connectedPids = new Set<number>();
  private readonly interceptingPids = new Set<number>();

  public connect(pid: number): void {
    this.connectedPids.add(pid);
    // A new transport must acknowledge the current session snapshot itself.
    this.interceptingPids.delete(pid);
  }

  public acknowledge(pid: number, intercepting: boolean): boolean {
    if (!this.connectedPids.has(pid)) {
      return false;
    }
    if (intercepting) {
      this.interceptingPids.add(pid);
    } else {
      this.interceptingPids.delete(pid);
    }
    return true;
  }

  public disconnect(pid: number): void {
    this.connectedPids.delete(pid);
    this.interceptingPids.delete(pid);
  }

  public isEffective(requested: boolean): boolean {
    if (this.connectedPids.size === 0) {
      return false;
    }
    if (!requested) {
      return this.interceptingPids.size > 0;
    }
    for (const pid of this.connectedPids) {
      if (!this.interceptingPids.has(pid)) {
        return false;
      }
    }
    return true;
  }
}
