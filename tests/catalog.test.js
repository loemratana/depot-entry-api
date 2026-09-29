import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { FILES, api, createAdmin, listBucketKeys, login, mongoose, start, stop } from "./helpers.js";

const { Brand } = await import("../src/modules/stock/brand.model.js");
const { Product } = await import("../src/modules/stock/product.model.js");

let token;

before(async () => {
    await start();
    await createAdmin();
    token = await login();
});
after(stop);

const admin = (path, options = {}) => api(`/admin/stock${path}`, { token, ...options });
const catalog = async () => (await api("/public/stock/catalog")).body.data.brands;
const logoForm = (blob, name = "logo.png") => {
    const form = new FormData();
    form.append("logo", blob, name);
    return form;
};

describe("brands", () => {
    let ganzberg;
    let idol;

    test("create brands; order follows creation; all fields by default", async () => {
        const a = await admin("/brands", { method: "POST", json: { name: "  GANZBERG  ", nameKh: "ហ្គែនប៊ឺក" } });
        assert.equal(a.status, 201, JSON.stringify(a.body));
        ganzberg = a.body.data;
        assert.equal(ganzberg.name, "GANZBERG");
        assert.deepEqual(ganzberg.measures, ["cases", "canRings", "cashRingsUsd", "cashRingsKhr"]);
        assert.equal(ganzberg.logoUrl, null);

        const b = await admin("/brands", { method: "POST", json: { name: "IDOL", measures: ["cases"] } });
        idol = b.body.data;
        assert.deepEqual(idol.measures, ["cases"]);
        assert.ok(idol.sortOrder > ganzberg.sortOrder);
    });

    test("duplicate names (ignoring case and spacing) and bad fields are rejected", async () => {
        assert.equal((await admin("/brands", { method: "POST", json: { name: "ganz berg" } })).status, 409);
        const bad = await admin("/brands", { method: "POST", json: { name: "X", measures: ["kula"] } });
        assert.equal(bad.status, 400);
        assert.equal((await admin("/brands", { method: "POST", json: { name: "X", measures: [] } })).status, 400);
        assert.equal((await admin("/brands", { method: "POST", json: { name: "   " } })).status, 400);
    });

    test("update name, Khmer name, fields and active state", async () => {
        const res = await admin(`/brands/${idol.id}`, {
            method: "PATCH",
            json: { name: "IDOL Energy", nameKh: "អាយដល", measures: ["cases", "canRings"], isActive: false }
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.name, "IDOL Energy");
        assert.deepEqual(res.body.data.measures, ["cases", "canRings"]);
        assert.equal(res.body.data.isActive, false);
        assert.equal((await admin(`/brands/${idol.id}`, { method: "PATCH", json: { name: "GANZBERG" } })).status, 409);
        assert.equal((await admin(`/brands/${idol.id}`, { method: "PATCH", json: {} })).status, 400);
        assert.equal((await admin(`/brands/${new mongoose.Types.ObjectId()}`, { method: "PATCH", json: { name: "Z" } })).status, 404);
    });

    test("move up/down changes the form order", async () => {
        const moved = await admin(`/brands/${idol.id}/move`, { method: "POST", json: { direction: "up" } });
        assert.equal(moved.status, 200);
        assert.deepEqual(moved.body.data.map((b) => b.name), ["IDOL Energy", "GANZBERG"]);
        // Already first: nothing changes
        const again = await admin(`/brands/${idol.id}/move`, { method: "POST", json: { direction: "up" } });
        assert.deepEqual(again.body.data.map((b) => b.name), ["IDOL Energy", "GANZBERG"]);
        await admin(`/brands/${idol.id}/move`, { method: "POST", json: { direction: "down" } });
    });

    describe("products", () => {
        let snow;

        test("add products to a brand; duplicates within the brand are rejected", async () => {
            const res = await admin(`/brands/${ganzberg.id}/products`, { method: "POST", json: { name: "Ganzberg Snow" } });
            assert.equal(res.status, 201, JSON.stringify(res.body));
            snow = res.body.data.products[0];
            await admin(`/brands/${ganzberg.id}/products`, { method: "POST", json: { name: "Ganzberg Gold" } });
            assert.equal((await admin(`/brands/${ganzberg.id}/products`, { method: "POST", json: { name: "ganzberg snow" } })).status, 409);
            // The same name is fine under another brand
            assert.equal((await admin(`/brands/${idol.id}/products`, { method: "POST", json: { name: "Ganzberg Snow" } })).status, 201);
        });

        test("rename, deactivate and reorder products", async () => {
            const renamed = await admin(`/products/${snow.id}`, { method: "PATCH", json: { name: "Ganzberg Snow 330ml" } });
            assert.equal(renamed.status, 200);
            assert.equal(renamed.body.data.products.find((p) => p.id === snow.id).name, "Ganzberg Snow 330ml");

            const moved = await admin(`/products/${snow.id}/move`, { method: "POST", json: { direction: "down" } });
            assert.deepEqual(moved.body.data.products.map((p) => p.name), ["Ganzberg Gold", "Ganzberg Snow 330ml"]);

            const off = await admin(`/products/${snow.id}`, { method: "PATCH", json: { isActive: false } });
            assert.equal(off.body.data.products.find((p) => p.id === snow.id).isActive, false);
        });

        test("the public catalog only shows active brands and active products", async () => {
            const brands = await catalog();
            // IDOL Energy is inactive; Snow is inactive
            assert.deepEqual(brands.map((b) => [b.name, b.products.map((p) => p.name)]), [["GANZBERG", ["Ganzberg Gold"]]]);
        });

        test("delete a product", async () => {
            const res = await admin(`/products/${snow.id}`, { method: "DELETE" });
            assert.equal(res.status, 200);
            assert.equal(await Product.countDocuments({ _id: snow.id }), 0);
            assert.equal((await admin(`/products/${snow.id}`, { method: "DELETE" })).status, 404);
        });
    });

    describe("logo", () => {
        test("upload a logo; it is served publicly for the form, cross-origin, cached", async () => {
            const res = await admin(`/brands/${ganzberg.id}/logo`, { method: "PUT", form: logoForm(FILES.png()) });
            assert.equal(res.status, 200, JSON.stringify(res.body));
            const logoUrl = res.body.data.logoUrl;
            assert.match(logoUrl, new RegExp(`^/public/stock/brands/${ganzberg.id}/logo\\?v=\\d+$`));

            // The public catalog carries the same URL
            assert.equal((await catalog())[0].logoUrl, logoUrl);

            const image = await api(logoUrl);
            assert.equal(image.status, 200);
            assert.equal(image.headers.get("content-type"), "image/png");
            assert.equal(image.headers.get("cross-origin-resource-policy"), "cross-origin");
            assert.match(image.headers.get("cache-control"), /max-age=\d+/);
            assert.deepEqual(image.body, Buffer.from(await FILES.png().arrayBuffer()));
        });

        test("replacing the logo removes the old image from storage", async () => {
            const before = await listBucketKeys(`brands/${ganzberg.id}/`);
            assert.equal(before.length, 1);
            await admin(`/brands/${ganzberg.id}/logo`, { method: "PUT", form: logoForm(FILES.jpg(), "logo.jpg") });
            const after = await listBucketKeys(`brands/${ganzberg.id}/`);
            assert.equal(after.length, 1);
            assert.notEqual(after[0], before[0]);
        });

        test("only real PNG/JPG/WebP images are accepted", async () => {
            assert.equal((await admin(`/brands/${ganzberg.id}/logo`, { method: "PUT", form: logoForm(FILES.fakePng()) })).status, 415);
            assert.equal((await admin(`/brands/${ganzberg.id}/logo`, { method: "PUT", form: logoForm(FILES.pdf(), "logo.pdf") })).status, 415);
            const svg = new Blob(["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"], { type: "image/svg+xml" });
            assert.equal((await admin(`/brands/${ganzberg.id}/logo`, { method: "PUT", form: logoForm(svg, "x.svg") })).status, 415);
            assert.equal((await admin(`/brands/${ganzberg.id}/logo`, { method: "PUT", form: new FormData() })).status, 400);
        });

        test("remove the logo", async () => {
            const res = await admin(`/brands/${ganzberg.id}/logo`, { method: "DELETE" });
            assert.equal(res.body.data.logoUrl, null);
            assert.equal((await api(`/public/stock/brands/${ganzberg.id}/logo`)).status, 404);
            assert.equal((await listBucketKeys(`brands/${ganzberg.id}/`)).length, 0);
        });
    });

    test("deleting a brand deletes its products and logo", async () => {
        await admin(`/brands/${idol.id}/logo`, { method: "PUT", form: logoForm(FILES.png()) });
        const res = await admin(`/brands/${idol.id}`, { method: "DELETE" });
        assert.equal(res.status, 200);
        assert.equal(await Brand.countDocuments({ _id: idol.id }), 0);
        assert.equal(await Product.countDocuments({ brandId: idol.id }), 0);
        assert.equal((await listBucketKeys(`brands/${idol.id}/`)).length, 0);
    });

    test("managing brands requires an admin login", async () => {
        assert.equal((await api("/admin/stock/brands")).status, 401);
        assert.equal((await api("/admin/stock/brands", { method: "POST", json: { name: "X" } })).status, 401);
        assert.equal((await api(`/admin/stock/brands/${ganzberg.id}/logo`, { method: "PUT", form: logoForm(FILES.png()) })).status, 401);
    });
});
