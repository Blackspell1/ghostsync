-- CreateTable
CREATE TABLE "ConnectedStore" (
    "id" SERIAL NOT NULL,
    "shopDomainA" TEXT NOT NULL,
    "shopDomainB" TEXT NOT NULL,
    "accessTokenA" TEXT NOT NULL,
    "accessTokenB" TEXT NOT NULL,
    "primaryLocationIdA" BIGINT,
    "primaryLocationIdB" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectedStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMapping" (
    "id" SERIAL NOT NULL,
    "storeGroupId" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "variantIdA" BIGINT NOT NULL,
    "inventoryItemIdA" BIGINT NOT NULL,
    "variantIdB" BIGINT NOT NULL,
    "inventoryItemIdB" BIGINT NOT NULL,
    "syncedQuantity" INTEGER NOT NULL DEFAULT 0,
    "isSyncing" BOOLEAN NOT NULL DEFAULT false,
    "lastSync" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "InventoryMapping" ADD CONSTRAINT "InventoryMapping_storeGroupId_fkey" FOREIGN KEY ("storeGroupId") REFERENCES "ConnectedStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
