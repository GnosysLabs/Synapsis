import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { getCurrentBuildInfo, getLatestPublishedBuild, compareBuildVersions } from '@/lib/version';
import { getHostUpdaterStatus, triggerHostUpdate, updateHostUpdaterConfig } from '@/lib/host-updater';

function isUpdateAvailable(currentVersion: string, latestVersion: string | null | undefined) {
  if (!latestVersion) {
    return false;
  }

  return compareBuildVersions(currentVersion, latestVersion) < 0;
}

export async function GET() {
  try {
    await requireAdmin();

    const [latest, updater] = await Promise.all([
      getLatestPublishedBuild(),
      getHostUpdaterStatus(),
    ]);

    const current = getCurrentBuildInfo();

    return NextResponse.json({
      current,
      latest,
      updateAvailable: isUpdateAvailable(current.version, latest?.version),
      updater,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Admin required') {
      return NextResponse.json({ error: 'Admin required' }, { status: 403 });
    }

    console.error('[Admin Update] Status error:', error);
    return NextResponse.json({ error: 'Failed to get update status' }, { status: 500 });
  }
}

export async function POST() {
  try {
    await requireAdmin();

    const result = await triggerHostUpdate();
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Admin required') {
      return NextResponse.json({ error: 'Admin required' }, { status: 403 });
    }

    console.error('[Admin Update] Trigger error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to trigger update' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();

    const body = await request.json();
    if (typeof body.autoUpdateEnabled !== 'boolean') {
      return NextResponse.json({ error: 'autoUpdateEnabled must be a boolean' }, { status: 400 });
    }

    const result = await updateHostUpdaterConfig(body.autoUpdateEnabled);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Admin required') {
      return NextResponse.json({ error: 'Admin required' }, { status: 403 });
    }

    console.error('[Admin Update] Config error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update auto-update settings' },
      { status: 500 }
    );
  }
}
