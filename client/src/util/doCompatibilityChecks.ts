import { EntryCard } from '../controllers';
import { MOVIE_SOURCE, MOVIE_TYPE } from '../main';

/** Ensures the browser can play the movie. */
export function doCompatibilityChecks(): Promise<boolean> {
    return new Promise((resolve) => {
        const videoElement = document.createElement('video');

        function cleanupAndResolve(result: boolean): void {
            videoElement.removeEventListener('error', handleError);
            videoElement.removeEventListener('canplay', handleCanPlay);
            videoElement.remove();

            resolve(result);
        }

        function handleError(): void {
            EntryCard.show({
                title: 'Incompatible Browser',
                description: 'You need to be on Chrome.',
            });
            cleanupAndResolve(false);
        }

        function handleCanPlay(): void {
            cleanupAndResolve(true);
        }

        videoElement.addEventListener('error', handleError);
        videoElement.addEventListener('canplay', handleCanPlay);

        if (new RegExp(/mobile/, 'ig').test(navigator.userAgent)) {
            EntryCard.show({
                title: 'Incompatible Device',
                description: 'Mobile not supported.',
            });
            cleanupAndResolve(false);
        }

        videoElement.setAttribute('type', MOVIE_TYPE);
        videoElement.src = MOVIE_SOURCE;
    });
}
