import type { Database, ArtifactRow, ArtifactDirection } from './types.js';
export declare function createArtifact(db: Database, name: string, artifactPath: string): string;
export declare function publishArtifact(db: Database, artifactId: string, artifactPath: string, checksum: string): void;
export declare function verifyArtifact(db: Database, artifactId: string): 'available' | 'stale' | 'missing' | 'pending';
export declare function linkTaskArtifact(db: Database, taskId: string, artifactId: string, direction: ArtifactDirection): void;
export declare function computeChecksum(filePath: string): string;
export declare function findArtifactByName(db: Database, name: string): ArtifactRow | undefined;
export declare function validateArtifactPath(artifactPath: string, projectDir: string): string;
//# sourceMappingURL=artifact-ops.d.ts.map