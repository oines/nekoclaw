import { join } from "node:path";
import { StorePaths } from "../../store/paths.js";

export class PersonaPaths {
	constructor(
		private readonly storePaths: StorePaths,
		private readonly slug: string,
	) {}

	get personaDir(): string {
		return this.storePaths.getPersonaDir(this.slug);
	}

	get indexPath(): string {
		return this.storePaths.getPersonaIndexPath(this.slug);
	}

	get peopleDir(): string {
		return this.storePaths.getPersonaPeopleDir(this.slug);
	}

	get scenesDir(): string {
		return this.storePaths.getPersonaScenesDir(this.slug);
	}

	get observationsDir(): string {
		return this.storePaths.getPersonaObservationsDir(this.slug);
	}

	get controlDir(): string {
		return this.storePaths.getPersonaControlDir(this.slug);
	}

	get dreamStatePath(): string {
		return this.storePaths.getPersonaDreamStatePath(this.slug);
	}

	get formationRetryDir(): string {
		return join(this.controlDir, "formation-retries");
	}

	observationPath(sceneRef: string): string {
		return this.storePaths.getPersonaObservationPath(this.slug, sceneRef);
	}

	formationRetryStatePath(sceneRef: string): string {
		return join(this.formationRetryDir, `${sceneRef}.json`);
	}
}
