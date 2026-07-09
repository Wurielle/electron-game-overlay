declare global {
    var DEBUG: any;
    var CONFIG: {
        distDir: string;
        entryUrl: string;
        resolveRendererUrl: (route: string) => string;
    };
}

export {};
