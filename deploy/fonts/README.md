# Шрифты для кадра

Сюда можно положить `.ttf`/`.otf` — при сборке образа они попадают
в `/usr/share/fonts/reels/` и становятся доступны Chromium.

Зачем это нужно. Кадр набран Inter (`packages/core/src/theme.ts`), но
в Alpine этого шрифта нет, и без него сцена откатится на Noto Sans:
кириллица на месте, вёрстка не ломается — потоковые блоки подстраиваются
сами, — но рисунок букв будет другим, и ролики с локальной машины и
с сервера перестанут совпадать.

Чтобы совпадали, скачайте Inter (https://rsms.me/inter/, лицензия SIL OFL)
и положите сюда файлы:

    Inter-Regular.otf
    Inter-Medium.otf
    Inter-SemiBold.otf
    Inter-Bold.otf
    Inter-ExtraBold.otf
    InterDisplay-Bold.otf
    InterDisplay-ExtraBold.otf

Этого набора хватает: роли `display`, `title` и `price` используют
начертания 700–800, остальные — 400–600.

Свой фирменный шрифт подключается так же: положите файлы и пропишите
семейство в `fontDisplay` / `fontBody` в `packages/core/src/theme.ts`.
Шрифт должен покрывать кириллицу, иначе текст превратится в квадраты.
