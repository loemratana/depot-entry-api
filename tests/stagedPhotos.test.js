/**
 * Photos uploaded while the form is being filled in (staged), then attached to
 * the outlet on Submit by uploadId.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
    FILES,
    Submission,
    api,
    createAdmin,
    createLocations,
    listBucketKeys,
    login,
    start,
    stop,
    validFields,
    withGpsPhotos
} from "./helpers.js";

const { StagedPhoto } = await import("../src/modules/submission/stagedPhoto.model.js");
const { cleanupStagedPhotos } = await import("../src/modules/submission/stagedPhoto.service.js");

let fx;
let token;

before(async () => {
    await start();
    fx = await createLocations();
    await createAdmin();
    token = await login();
});
after(stop);

let photoCounter = 0;
const newPhotoId = () => `staged-photo-${Date.now().toString(36)}-${photoCounter++}`;

const stage = (blob = FILES.jpg(), name = "site.jpg", { path = "/public/submissions/photos", auth } = {}) => {
    const form = new FormData();
    form.append("photo", blob, name);
    return api(path, { method: "POST", form, token: auth });
};

const gps = (photoId, latitude = 11.5564) => ({
    photoId,
    latitude,
    longitude: 104.9282,
    accuracy: 10,
    capturedAt: new Date().toISOString()
});

/** A form with no files, only staged photos (and their GPS) */
const stagedForm = (staged, overrides = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(validFields(fx, overrides))) form.append(key, value);
    form.append("stagedPhotos", JSON.stringify(staged.map(({ photoId, uploadId }) => ({ photoId, uploadId }))));
    form.append("sitePhotoMeta", JSON.stringify(staged.map(({ photoId, latitude }) => gps(photoId, latitude))));
    return form;
};

const submitForm = (form, path = "/public/submissions", auth) => api(path, { method: "POST", form, token: auth });

const stageOne = async () => {
    const res = await stage();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { photoId: newPhotoId(), uploadId: res.body.data.uploadId };
};

describe("staged site photos", () => {
    test("a photo is stored before Submit and gets an unguessable uploadId", async () => {
        const res = await stage();
        assert.equal(res.status, 201);
        assert.match(res.body.data.uploadId, /^[A-Za-z0-9_-]{32}$/);
        const doc = await StagedPhoto.findOne({ uploadId: res.body.data.uploadId }).lean();
        assert.ok(doc.objectKey.startsWith("staged/"));
        assert.ok((await listBucketKeys("staged/")).includes(doc.objectKey));
        assert.ok(new Date(res.body.data.expiresAt) > new Date(Date.now() + 23 * 3600 * 1000));
    });

    test("only real JPG, PNG or WebP images are accepted", async () => {
        assert.equal((await stage(FILES.pdf(), "doc.pdf")).status, 415);
        assert.equal((await stage(FILES.fakePng(), "fake.png")).status, 415);
        const none = await api("/public/submissions/photos", { method: "POST", form: new FormData() });
        assert.equal(none.status, 400);
    });

    test("Submit with only uploadIds creates the outlet with the photos and their GPS", async () => {
        const a = { ...(await stageOne()), latitude: 12.1 };
        const b = { ...(await stageOne()), latitude: 12.2 };
        const res = await submitForm(stagedForm([a, b]));
        assert.equal(res.status, 201, JSON.stringify(res.body));

        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        assert.equal(outlet.files.length, 2);
        // In the order they were added, each with its own GPS
        assert.deepEqual(
            outlet.files.map((f) => [f.photoId, f.location.coordinates[1]]),
            [
                [a.photoId, 12.1],
                [b.photoId, 12.2]
            ]
        );
        const keys = await listBucketKeys(`submissions/${outlet._id}/`);
        assert.deepEqual(keys.sort(), outlet.files.map((f) => f.objectKey).sort());
        assert.equal(outlet.files[0].mimeType, "image/jpeg");

        // The staged copies are tidied away
        assert.equal(await StagedPhoto.countDocuments({ uploadId: { $in: [a.uploadId, b.uploadId] } }), 0);
    });

    test("an uploadId works only once", async () => {
        const a = await stageOne();
        assert.equal((await submitForm(stagedForm([a]))).status, 201);
        const again = await submitForm(stagedForm([a], { phone: "098765432" }));
        assert.equal(again.status, 400);
        assert.equal(again.body.errors[0].field, `stagedPhotos.${a.photoId}`);
    });

    test("an unknown or expired uploadId asks for the photo again", async () => {
        const unknown = { photoId: newPhotoId(), uploadId: "x".repeat(32) };
        const res = await submitForm(stagedForm([unknown]));
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].field, `stagedPhotos.${unknown.photoId}`);

        const expired = await stageOne();
        await StagedPhoto.updateOne({ uploadId: expired.uploadId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        assert.equal((await submitForm(stagedForm([expired]))).status, 400);
    });

    test("a staged photo needs GPS like any photo", async () => {
        const a = await stageOne();
        const form = stagedForm([a]);
        form.set("sitePhotoMeta", "[]");
        const res = await submitForm(form);
        assert.equal(res.status, 400);
        assert.equal(res.body.errors[0].field, `stagedPhotos.${a.photoId}`);
    });

    test("a rejected form leaves the photo usable for the retry", async () => {
        const a = await stageOne();
        const bad = await submitForm(stagedForm([a], { phone: "1" }));
        assert.equal(bad.status, 400);
        assert.equal((await submitForm(stagedForm([a]))).status, 201);
    });

    test("staged photos and photos sent with the form can be mixed, within the file limit", async () => {
        const a = await stageOne();
        const form = withGpsPhotos(stagedForm([a]), [["inline.jpg", FILES.jpg()]]);
        const res = await submitForm(form);
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const outlet = await Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
        assert.equal(outlet.files.length, 2);

        // 3 staged + 1 sent is over the limit of 3 (tests)
        const many = [await stageOne(), await stageOne(), await stageOne()];
        const over = await submitForm(withGpsPhotos(stagedForm(many), [["inline.jpg", FILES.jpg()]]));
        assert.equal(over.status, 400);
        assert.equal(over.body.errors[0].field, "files");
        // Nothing was used up
        assert.equal(await StagedPhoto.countDocuments({ uploadId: { $in: many.map((m) => m.uploadId) }, claimedBy: null }), 3);
    });

    test("admin Add outlet uses its own upload, which needs the create permission", async () => {
        assert.equal((await stage(FILES.jpg(), "a.jpg", { path: "/admin/submissions/photos" })).status, 401);
        const res = await stage(FILES.jpg(), "a.jpg", { path: "/admin/submissions/photos", auth: token });
        assert.equal(res.status, 201);
        const a = { photoId: newPhotoId(), uploadId: res.body.data.uploadId };
        const created = await submitForm(stagedForm([a]), "/admin/submissions", token);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const outlet = await Submission.findOne({ submissionNo: created.body.data.submissionNo }).lean();
        assert.ok(outlet.files[0].uploadedBy);
    });

    test("clean-up removes unused expired photos and releases claims whose outlet was never saved", async () => {
        const unused = await stageOne();
        await StagedPhoto.updateOne({ uploadId: unused.uploadId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        const unusedKey = (await StagedPhoto.findOne({ uploadId: unused.uploadId }).lean()).objectKey;

        const stuck = await stageOne();
        await StagedPhoto.updateOne(
            { uploadId: stuck.uploadId },
            { $set: { claimedBy: new Submission()._id, claimedAt: new Date(Date.now() - 2 * 3600 * 1000) } }
        );

        const removed = await cleanupStagedPhotos();
        assert.ok(removed >= 1);
        assert.equal(await StagedPhoto.countDocuments({ uploadId: unused.uploadId }), 0);
        assert.ok(!(await listBucketKeys("staged/")).includes(unusedKey));
        // The stuck photo can be used again
        assert.equal((await StagedPhoto.findOne({ uploadId: stuck.uploadId }).lean()).claimedBy, null);
        assert.equal((await submitForm(stagedForm([stuck]))).status, 201);
    });
});
