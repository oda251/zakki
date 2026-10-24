declare module "d3-force-3d" {
  export interface CollisionForce<Node> {
    (alpha: number): void;
    initialize(nodes: Node[], random?: () => number, numDimensions?: number): void;
    radius(): (node: Node) => number;
    radius(radius: number | ((node: Node) => number)): this;
    iterations(iterations: number): this;
  }

  export interface PositionForce<Node> {
    (alpha: number): void;
    initialize(nodes: Node[], random?: () => number, numDimensions?: number): void;
    strength(): (node: Node) => number;
    strength(strength: number | ((node: Node) => number)): this;
  }

  export function forceCollide<Node>(
    radius?: number | ((node: Node) => number),
  ): CollisionForce<Node>;

  export function forceX<Node>(x?: number | ((node: Node) => number)): PositionForce<Node>;

  export function forceY<Node>(y?: number | ((node: Node) => number)): PositionForce<Node>;
}
