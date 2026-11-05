export declare function blueprint(o: { path: string }): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext) => void;
export declare function event(m: Function, ctx: ClassMethodDecoratorContext): void;
