/** An operator decision, not a plugin failure that an error branch may recover. */
export class ReviewHoldSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ReviewHoldSignal';
  }
}
