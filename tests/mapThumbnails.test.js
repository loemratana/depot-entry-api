/**
 * Outlet map thumbnails: small previews made once per photo, and image links
 * that stay the same between requests so the browser can cache them.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
    FILES,
    Submission,
    api,
    createAdmin,
    createLocations,
    listBucketKeys,
    login,
    minioClient,
    BUCKET,
    start,
    stop,
    submissionForm,
    validFields,
    withGpsPhotos
} from "./helpers.js";

let fx;
let token;

before(async () => {
    await start();
    await createAdmin();
    fx = await createLocations();
    token = await login();
});
after(stop);

/** A real, decodable photo-like JPEG */
const realJpeg = async (width = 1200, height = 900) =>
    new Blob(
        [
            await sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } })
                .jpeg({ quality: 90 })
                .toBuffer()
        ],
        { type: "image/jpeg" }
    );

const createOutlet = async (name, photo) => {
    const form = withGpsPhotos(submissionForm(validFields(fx, { clientName: name }), []), [["shop.jpg", photo]]);
    const res = await api("/public/submissions", { method: "POST", form });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return Submission.findOne({ submissionNo: res.body.data.submissionNo }).lean();
};

const getMap = (query = "") => api(`/admin/map/submissions${query}`, { token });

const download = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

describe("outlet map thumbnails", () => {
    let outlet;

    before(async () => {
        outlet = await createOutlet("Thumb Outlet", await realJpeg());
    });

    test("each marker gets a small thumbnail, made once and kept with the photo", async () => {
        const res = await getMap(`?submissionId=${outlet._id}`);
        assert.equal(res.status, 200);
        const [point] = res.body.data;
        assert.match(point.thumbnailUrl, /X-Amz-Signature=/);
        assert.equal(point.thumbnailPending, false);

        const thumb = await download(point.thumbnailUrl);
        const meta = await sharp(thumb).metadata();
        assert.equal(meta.format, "jpeg");
        assert.equal(meta.width, 160);
        assert.equal(meta.height, 160);
        assert.ok(thumb.length < 15 * 1024, `${thumb.length} bytes`);

        const saved = await Submission.findById(outlet._id).lean();
        assert.match(saved.files[0].thumbnailKey, /^thumbnails\/submissions\/.+\.jpg$/);
        assert.deepEqual(await listBucketKeys("thumbnails/"), [saved.files[0].thumbnailKey]);
    });

    test("the same links come back on the next request, so the browser can cache the images", async () => {
        const first = (await getMap(`?submissionId=${outlet._id}`)).body.data[0];
        const second = (await getMap(`?submissionId=${outlet._id}`)).body.data[0];
        assert.equal(second.thumbnailUrl, first.thumbnailUrl);
        assert.equal(second.photoUrl, first.photoUrl);
        assert.match(first.thumbnailUrl, /response-cache-control=private/);
        // The thumbnail is not made again
        assert.equal((await listBucketKeys("thumbnails/")).length, 1);
        assert.ok(new Date(first.photoUrlExpiresAt) > new Date(Date.now() + 5 * 3600 * 1000));
    });

    test("a photo that cannot be read has no thumbnail, and the map still loads", async () => {
        const broken = await createOutlet("Broken Photo Outlet", FILES.jpg());
        const res = await getMap(`?submissionId=${broken._id}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data[0].thumbnailUrl, null);
        // Not pending: the page does not keep asking for it
        assert.equal(res.body.data[0].thumbnailPending, false);
        assert.match(res.body.data[0].photoUrl, /X-Amz-Signature=/);
    });

    test("deleting the outlet also deletes its thumbnail", async () => {
        const other = await createOutlet("Delete Thumb Outlet", await realJpeg(800, 600));
        await getMap(`?submissionId=${other._id}`);
        const key = (await Submission.findById(other._id).lean()).files[0].thumbnailKey;
        assert.ok((await listBucketKeys("thumbnails/")).includes(key));

        const res = await api(`/admin/submissions/${other._id}`, { method: "DELETE", token });
        assert.equal(res.status, 200);
        assert.ok(!(await listBucketKeys("thumbnails/")).includes(key));
        await assert.rejects(minioClient.statObject(BUCKET, key));
    });
});
