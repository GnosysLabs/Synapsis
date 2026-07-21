import { redirect } from 'next/navigation';

/** Preserve old bookmarks while Explore's post feed moves into Home → For You. */
export default function ExplorePage() {
    redirect('/search?tab=users');
}
