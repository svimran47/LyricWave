package app.lyricwave.twa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Looks for a new web bundle about every 30 minutes while the app is closed (it also runs after a
 * reboot) and, when a verified one has been downloaded, shows a "LyricWave update ready"
 * notification. Tapping it opens the app straight onto the new version
 * (MainActivity.EXTRA_APPLY_WEB_UPDATE). Nothing is applied without that tap.
 */
public class UpdateCheckJobService extends JobService {

    static final String CHANNEL_ID = "web_updates";
    static final int JOB_ID = 4711;
    private static final int NOTIFICATION_ID = 4712;
    private static final long INTERVAL_MS = 30L * 60 * 1000;

    /** Schedules the periodic check once; harmless to call on every launch. */
    static void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        for (JobInfo pending : scheduler.getAllPendingJobs()) {
            if (pending.getId() == JOB_ID) return;
        }
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, UpdateCheckJobService.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .setPeriodic(INTERVAL_MS)
                .build();
        try {
            scheduler.schedule(job);
        } catch (RuntimeException e) {
            // Background checks are optional: the app must still open if scheduling is refused.
        }
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        final Context app = getApplicationContext();
        new Thread(() -> {
            try {
                WebUpdater updater = WebUpdater.get(app);
                if (updater.isAutoCheckPaused()) return;
                updater.checkBlocking();
                long ready = updater.readyVersion();
                if (ready > 0 && updater.notificationsEnabled() && updater.shouldNotify(ready)) {
                    if (notifyReady(app)) updater.markNotified(ready);
                }
            } catch (RuntimeException ignored) {
                // Best effort: the next run tries again.
            } finally {
                jobFinished(params, false);
            }
        }, "web-update-job").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    /** Shows the notification; false when notifications are off or blocked. */
    private static boolean notifyReady(Context app) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(app);
        if (!manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "App updates",
                    NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Tells you when a new version of LyricWave is ready");
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(app, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .putExtra(MainActivity.EXTRA_APPLY_WEB_UPDATE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent tap = PendingIntent.getActivity(app, 0, open, flags);
        Notification n = new NotificationCompat.Builder(app, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("LyricWave update ready")
                .setContentText("Tap to update. It only takes a moment.")
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build();
        try {
            manager.notify(NOTIFICATION_ID, n);
            return true;
        } catch (SecurityException e) {
            return false; // POST_NOTIFICATIONS not granted
        }
    }
}
