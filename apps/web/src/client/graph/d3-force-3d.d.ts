declare module "d3-force-3d" {
  export interface CollisionForce<Node> {
    (alpha: number): void;
    initialize(nodes: Node[], random?: () => number, numDimensions?: number): void;
    radius(): (node: Node) => number;
    radius(radius: number | ((node: Node) => number)): this;
    iterations(iterations: number): this;
  }

  export function forceCollide<Node>(
    radius?: number | ((node: Node) => number),
  ): CollisionForce<Node>;
}
