import brandSheet from "../MCImages.png";

type BrandAsset = "mark-compact" | "agent-research" | "agent-coding" | "agent-testing" | "agent-deployment";

export function BrandSprite({ asset, className = "" }: { asset: BrandAsset; className?: string }) {
  if (asset === "mark-compact") {
    return (
      <span
        aria-hidden="true"
        className={`brand-sprite brand-mark-compact ${className}`}
        style={{ backgroundImage: "url(/mission-control-mark.svg)" }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`brand-sprite brand-${asset} ${className}`}
      style={{ backgroundImage: `url(${brandSheet.src})` }}
    />
  );
}
