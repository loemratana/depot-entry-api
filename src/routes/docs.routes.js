import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "../docs/swagger.js";

const router = Router();

router.get("/docs.json", (req, res) => {
    res.json(swaggerSpec);
});

router.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
        customSiteTitle: "Client Management API Docs",
        swaggerOptions: {
            displayRequestDuration: true,
            persistAuthorization: true,
            tryItOutEnabled: true
        }
    })
);

export default router;
