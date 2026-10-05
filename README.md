# Kiosco local

Aplicación web local para gestión de un kiosco. La primera versión usa un kiosco y un usuario ficticios; cada entidad de negocio guarda `tenant_id` desde el inicio para que el modelo permita separar negocios en una siguiente etapa.

## Iniciar

Requisitos: Node.js 22.13 o superior.

```sh
npm install
npm run dev
```

Abrí <http://127.0.0.1:5173/>. La API local escucha en `127.0.0.1:3001`. La base SQLite se crea automáticamente en `data/kiosco.sqlite` con categorías y productos de muestra.

## Qué funciona en esta primera entrega

- Catálogo: listar, buscar, crear y editar productos, categorías y proveedores.
- Productos: agregar variantes con stock y SKU propios; el stock general se calcula sumando sus variantes.
- Variantes: el stock de productos con variantes se conserva únicamente por variante; las compras exigen seleccionar una, el POS descuenta de la variante vendida y no se pueden quitar variantes con unidades disponibles.
- SKU: los códigos de productos y variantes son únicos dentro del kiosco, sin distinguir mayúsculas/minúsculas.
- Inventario: filtrar existencias bajas o agotadas.
- Compras: registrar cantidades y costo unitario; la existencia sube al confirmar y se registra el egreso en caja abierta.
- Punto de venta: asignar cliente, respetar precios del servidor, validar existencias y aceptar pagos combinados.
- Caja: abrir sesión, registrar ingresos/retiros, asociar pagos en efectivo/compras, consultar movimientos, comparar el efectivo esperado con el contado y cerrar con diferencia.
- Tickets: mostrar productos, cantidades, cliente y medios de pago; imprimir un comprobante interno.
- Clientes: alta y selección al vender.
- Reporte inicial: resumen de tickets, ventas y alertas de stock.

## Próximos pasos del plan

1. Adjuntar imágenes de productos y controlar vencimientos por lote.
2. Agregar descuentos, devoluciones, usuarios y permisos.
3. Reportes por período, rentabilidad y cierre histórico de caja.
4. Exportación/importación CSV e historial de cambios de inventario.
5. Revisión visual detallada de cada flujo con las capturas.

## Verificación de stock y variantes

```sh
npm run test:stock
```

La prueba de integración inicia una API y una base SQLite temporales; no modifica la base local del kiosco.

El ticket es interno y no emite factura fiscal. La base y sus registros de muestra son locales; no se envían a un servicio externo.

## Publicación web

Cloudflare Pages construye el frontend con `npm run build` y publica `dist/`. El backend Node.js y SQLite quedan para ejecución local.
