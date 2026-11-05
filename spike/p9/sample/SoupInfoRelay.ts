import { blueprint, event } from "../runtime/index.js";

@blueprint({ path: "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay" })
export class SoupInfoRelay {
  lastRowName = "";
  bLastVisible = false;

  @event
  updateTarget(): void {
    if (this.lastRowName === "") {
      this.bLastVisible = false;
      return;
    }
    this.bLastVisible = true;
  }
}
